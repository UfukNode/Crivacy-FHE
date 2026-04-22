/**
 * Env-backed Didit KYC provider client configuration.
 *
 * Mirrors the `@credential/core` config pattern: a single frozen object
 * carries every tunable, built by `loadDiditConfig()` from a plain
 * record (defaulted from `process.env`) and validated with Zod. No
 * helper in `@crivacy-fhe/adapter-didit` ever reads `process.env` directly.
 *
 *   1. Tests can call helpers with a locally-built config (short
 *      timeouts, in-memory fetch stub, fake api key) without
 *      monkey-patching globals.
 *   2. Production code always goes through `getDiditConfig()`, which
 *      caches the validated object per Node process so repeated
 *      reads do not re-parse the environment on every request.
 *
 * The config is split into four sections:
 *
 *   * Transport — base URL, api key, request timeout, retries
 *   * Workflows — KYC + Address workflow ids, callback base
 *   * Webhook   — signing secret, timestamp drift tolerance
 *   * Behavior  — whether to fail closed on unknown workflows, how
 *     strict the proof-hash builder should be on missing fields
 *
 * Field defaults match PLAN.md §6 (Didit sandbox on `verification.
 * didit.me`, 10s request timeout, 2 retries on idempotent reads, 5
 * minute webhook drift window).
 */

import { z } from 'zod';

import { DiditError } from './errors';
import { type DiditWorkflowId, asDiditWorkflowIdUnchecked } from './types';

/* ---------- Zod schema ---------- */

const PositiveInt = z.coerce.number().int().positive();
const NonNegativeInt = z.coerce.number().int().nonnegative();

/**
 * Didit base URL. Production + sandbox both run on HTTPS. We accept
 * HTTP for test fixtures that want to point at a loopback stub.
 */
const baseUrlSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'DIDIT_BASE_URL must be a valid http(s) URL.' },
  )
  .transform((value) => value.replace(/\/+$/, ''));

/**
 * Workflow id shape. Didit workflow ids are UUID v4 in their
 * documentation and in every decision we have seen. We pin the
 * regex so a typo fails at boot rather than on the first session
 * create. The regex is case-sensitive lowercase hex + hyphens.
 */
const workflowIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'Didit workflow id must be a lowercase UUID.',
  );

/**
 * Didit api key shape. We do not try to validate the cryptographic
 * contents — Didit is the authority. Shape pin is length + printable
 * ASCII to catch obvious typos (leading whitespace, null byte).
 */
const apiKeySchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[\x21-\x7e]+$/, 'DIDIT_API_KEY must be printable ASCII with no whitespace.');

/**
 * Webhook signing secret. Same pin: length + printable ASCII. The
 * secret is used with `crypto.createHmac('sha256', secret)` inside
 * `webhook.verifyWebhookSignature`, so whitespace would silently
 * produce the wrong HMAC.
 */
const webhookSecretSchema = z
  .string()
  .min(8)
  .max(512)
  .regex(/^[\x21-\x7e]+$/, 'DIDIT_WEBHOOK_SECRET must be printable ASCII with no whitespace.');

export const DiditConfigSchema = z.object({
  /* Transport */
  baseUrl: baseUrlSchema,
  apiKey: apiKeySchema,
  requestTimeoutMs: PositiveInt.max(120_000), // hard ceiling: 2 minutes
  maxRetries: NonNegativeInt.max(5),
  retryBaseDelayMs: NonNegativeInt.max(5_000),

  /* Workflows */
  kycWorkflowId: workflowIdSchema,
  addressWorkflowId: workflowIdSchema,
  defaultCallbackUrl: baseUrlSchema,

  /* Webhook */
  webhookSecret: webhookSecretSchema,
  webhookDriftSeconds: PositiveInt.max(3_600), // hard ceiling: 1 hour

  /* Behavior */
  failClosedOnUnknownWorkflow: z.boolean(),
  proofHashStrict: z.boolean(),
});

export type DiditConfigRaw = z.infer<typeof DiditConfigSchema>;

/**
 * The branded, frozen config consumers see. Workflow ids are cast
 * to `DiditWorkflowId` after Zod validation so downstream helpers
 * can use the nominal type without re-validating.
 */
export interface DiditConfig extends Omit<DiditConfigRaw, 'kycWorkflowId' | 'addressWorkflowId'> {
  readonly kycWorkflowId: DiditWorkflowId;
  readonly addressWorkflowId: DiditWorkflowId;
}

/* ---------- Defaults ---------- */

/**
 * Fallback values applied when the matching env var is unset. Values
 * that carry infrastructure identity (api key, workflow ids, webhook
 * secret) have no default and must be provided by the caller.
 */
const DEFAULTS = {
  DIDIT_BASE_URL: 'https://verification.didit.me',
  DIDIT_REQUEST_TIMEOUT_MS: '10000', // 10 seconds
  DIDIT_MAX_RETRIES: '2',
  DIDIT_RETRY_BASE_DELAY_MS: '250',
  DIDIT_WEBHOOK_DRIFT_SECONDS: '300', // 5 minutes
  DIDIT_FAIL_CLOSED_ON_UNKNOWN_WORKFLOW: 'true',
  DIDIT_PROOF_HASH_STRICT: 'true',
} as const;

export type DiditRequiredEnv =
  | 'DIDIT_API_KEY'
  | 'DIDIT_KYC_WORKFLOW_ID'
  | 'DIDIT_ADDRESS_WORKFLOW_ID'
  | 'DIDIT_WEBHOOK_SECRET'
  | 'DIDIT_DEFAULT_CALLBACK_URL';

/**
 * Union of the env keys we read. Declared explicitly so a typo in a
 * caller's override dictionary is a compile-time error.
 */
export type DiditEnv = Partial<
  Record<keyof typeof DEFAULTS | DiditRequiredEnv, string | undefined>
>;

/* ---------- Loader ---------- */

/**
 * Parse a boolean env value. Accepts `1` / `true` / `yes` as true,
 * everything else (including empty) as false. Lets tests flip the
 * behavior flag without monkey-patching.
 */
function parseBooleanEnv(value: string | undefined, fallback: string): boolean {
  const picked = (value ?? fallback).toLowerCase();
  return picked === '1' || picked === 'true' || picked === 'yes';
}

/**
 * Build a validated `DiditConfig` from an environment record.
 *
 * The caller can either pass an explicit record (used by tests) or
 * omit the argument to read `process.env`. The returned object is
 * frozen so it cannot be mutated in place.
 *
 * Validation errors are collected into a single `invalid_config`
 * error whose `cause` is the underlying `ZodError` so callers can
 * inspect individual issues through the observability pipeline.
 */
export function loadDiditConfig(env: DiditEnv = process.env as DiditEnv): DiditConfig {
  const pick = <K extends keyof typeof DEFAULTS>(key: K): string => env[key] ?? DEFAULTS[key];

  const requireEnv = (key: DiditRequiredEnv, hint: string): string => {
    const value = env[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new DiditError('invalid_config', `${key} is required (${hint}).`);
    }
    return value;
  };

  const apiKey = requireEnv('DIDIT_API_KEY', 'issued by the Didit dashboard');
  const kycWorkflowId = requireEnv('DIDIT_KYC_WORKFLOW_ID', 'UUID of the KYC + liveness workflow');
  const addressWorkflowId = requireEnv(
    'DIDIT_ADDRESS_WORKFLOW_ID',
    'UUID of the proof-of-address workflow',
  );
  const webhookSecret = requireEnv('DIDIT_WEBHOOK_SECRET', 'rotatable shared secret for HMAC');
  const defaultCallbackUrl = requireEnv(
    'DIDIT_DEFAULT_CALLBACK_URL',
    'https://app.crivacy.io/verification/callback',
  );

  const raw = {
    baseUrl: pick('DIDIT_BASE_URL'),
    apiKey,
    requestTimeoutMs: pick('DIDIT_REQUEST_TIMEOUT_MS'),
    maxRetries: pick('DIDIT_MAX_RETRIES'),
    retryBaseDelayMs: pick('DIDIT_RETRY_BASE_DELAY_MS'),
    kycWorkflowId,
    addressWorkflowId,
    defaultCallbackUrl,
    webhookSecret,
    webhookDriftSeconds: pick('DIDIT_WEBHOOK_DRIFT_SECONDS'),
    failClosedOnUnknownWorkflow: parseBooleanEnv(
      env.DIDIT_FAIL_CLOSED_ON_UNKNOWN_WORKFLOW,
      DEFAULTS.DIDIT_FAIL_CLOSED_ON_UNKNOWN_WORKFLOW,
    ),
    proofHashStrict: parseBooleanEnv(env.DIDIT_PROOF_HASH_STRICT, DEFAULTS.DIDIT_PROOF_HASH_STRICT),
  };

  const parsed = DiditConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DiditError(
      'invalid_config',
      `Didit config validation failed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      { cause: parsed.error },
    );
  }

  const data = parsed.data;
  const config: DiditConfig = Object.freeze({
    ...data,
    kycWorkflowId: asDiditWorkflowIdUnchecked(data.kycWorkflowId),
    addressWorkflowId: asDiditWorkflowIdUnchecked(data.addressWorkflowId),
  });
  return config;
}

/* ---------- Per-process cache ---------- */

let cached: DiditConfig | null = null;

/**
 * Return the singleton config for the current process. Built lazily
 * on the first call. Tests can call `resetDiditConfigForTests()` to
 * drop the cache between cases.
 */
export function getDiditConfig(): DiditConfig {
  if (cached === null) {
    cached = loadDiditConfig();
  }
  return cached;
}

/**
 * Drop the cached config. Only for test suites that mutate the
 * environment between cases.
 */
export function resetDiditConfigForTests(): void {
  cached = null;
}
