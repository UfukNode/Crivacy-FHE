/**
 * High-level Didit client facade.
 *
 * This is the module consumers outside `@crivacy-fhe/adapter-didit` should depend
 * on. It bundles a validated `DiditConfig`, a `FetchLike`, and a
 * `Clock` into a single object whose methods are a narrow, stable
 * interface. Internals are free to change without touching callers.
 *
 * The facade intentionally does not expose the low-level `diditFetch`
 * retry options or the Zod schemas — consumers should never tune the
 * HTTP layer or construct a raw fetch. They should only be able to:
 *
 *   * Create a KYC session for a given user
 *   * Create an Address (PoA) session for a given user
 *   * Fetch the decision for an existing session
 *   * Verify an incoming webhook (+ parse it into a typed body)
 *   * Reduce a decision into `DiditVerificationFlags` + a proof hash
 *
 * Every method on the facade is a pure function of the injected
 * dependencies + its arguments. No hidden state is kept between calls
 * — the client object is safe to share across concurrent requests.
 *
 * Creation sites:
 *
 *   * `createDiditClient(deps)` — explicit construction, used by
 *     tests and by any call site that wants to inject a stub fetch
 *     or a pinned clock.
 *   * `getDiditClient()` — singleton for production code that uses
 *     the env-derived config. Lazy on first call, process-lifetime
 *     cached.
 *   * `buildDiditClientFromEnv(env)` — construction from an explicit
 *     env record without touching the cached singleton. Used by the
 *     bootstrap checker at server startup.
 */

import type { DiditConfig } from './config';
import { getDiditConfig, loadDiditConfig } from './config';
import type { FetchLike } from './http';
import {
  type MergedVerificationFlags,
  computeProofHash,
  detectWorkflowType,
  mergeVerificationFlags,
  reduceDecision,
} from './mapping';
import type { ExpectedDetailsInput } from './session';
import {
  createAddressSession,
  createKycSession,
  getDecision,
  validateSessionId,
  validateVendorData,
  validateWorkflowId,
} from './session';
import type {
  CreateSessionResult,
  DiditDecisionPayload,
  DiditSessionId,
  DiditVendorData,
  DiditVerificationFlags,
  DiditWorkflowType,
} from './types';
import {
  type Clock,
  type WebhookVerificationInput,
  type WebhookVerificationResult,
  parseWebhookBody,
  verifyWebhook,
} from './webhook';

/* ---------- Construction ---------- */

/**
 * Dependencies accepted by `createDiditClient`. `config` is required;
 * `fetch` and `clock` default to the Node built-ins. Tests pass
 * deterministic stubs for the latter two so assertions stay stable.
 */
export interface DiditClientDeps {
  readonly config: DiditConfig;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
}

/**
 * The concrete facade object. Exposed as an interface so consumers
 * can accept it by type without importing the implementation class.
 */
export interface DiditClient {
  readonly config: DiditConfig;

  /* Validation helpers (re-exported so a caller can validate a
   * string without importing session.ts directly). */
  validateVendorData(raw: string): DiditVendorData;
  validateSessionId(raw: string): DiditSessionId;
  validateWorkflowIdShape(raw: string): ReturnType<typeof validateWorkflowId>;

  /* Session create */
  createKycSession(
    vendorData: DiditVendorData,
    callbackUrl: string,
    expectedDetails?: ExpectedDetailsInput,
  ): Promise<CreateSessionResult>;
  createAddressSession(
    vendorData: DiditVendorData,
    callbackUrl: string,
    expectedDetails?: ExpectedDetailsInput,
  ): Promise<CreateSessionResult>;

  /* Decision fetch */
  getDecision(sessionId: DiditSessionId): Promise<DiditDecisionPayload>;

  /* Webhook handling */
  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult;
  parseWebhookBody(body: unknown): ReturnType<typeof parseWebhookBody>;

  /* Mapping + proof hash */
  reduceDecision(decision: DiditDecisionPayload): DiditVerificationFlags;
  mergeVerificationFlags(flags: readonly DiditVerificationFlags[]): MergedVerificationFlags;
  computeProofHash(decision: DiditDecisionPayload): string;
  detectWorkflowType(workflowId: string): DiditWorkflowType;
}

/**
 * Build a client from explicit dependencies. The returned object is
 * frozen so callers cannot monkey-patch methods at runtime — a
 * footgun in a shared facade.
 */
export function createDiditClient(deps: DiditClientDeps): DiditClient {
  const { config } = deps;
  const fetchImpl = deps.fetch;
  const clock = deps.clock;

  const client: DiditClient = {
    config,

    validateVendorData,
    validateSessionId,
    validateWorkflowIdShape: validateWorkflowId,

    createKycSession(vendorData, callbackUrl, expectedDetails) {
      return createKycSession(config, vendorData, callbackUrl, expectedDetails, fetchImpl);
    },

    createAddressSession(vendorData, callbackUrl, expectedDetails) {
      return createAddressSession(config, vendorData, callbackUrl, expectedDetails, fetchImpl);
    },

    getDecision(sessionId) {
      return getDecision(config, sessionId, fetchImpl);
    },

    verifyWebhook(input) {
      return clock === undefined
        ? verifyWebhook(config, input)
        : verifyWebhook(config, input, clock);
    },

    parseWebhookBody,

    reduceDecision,
    mergeVerificationFlags,
    computeProofHash(decision) {
      return computeProofHash(config, decision);
    },
    detectWorkflowType(workflowId) {
      return detectWorkflowType(config, workflowId);
    },
  };

  return Object.freeze(client);
}

/* ---------- Singleton ---------- */

let cachedClient: DiditClient | null = null;

/**
 * Return the process-lifetime singleton, building it on first call
 * from the env-derived config. Tests should call
 * `resetDiditClientForTests()` between cases if they mutate the
 * environment or inject stubs.
 */
export function getDiditClient(): DiditClient {
  if (cachedClient === null) {
    cachedClient = createDiditClient({ config: getDiditConfig() });
  }
  return cachedClient;
}

/**
 * Drop the cached singleton. Only for test suites.
 */
export function resetDiditClientForTests(): void {
  cachedClient = null;
}

/**
 * Build a client from an explicit env record without touching the
 * cached singleton. Used by the bootstrap check so a misconfigured
 * env surfaces as a startup error instead of a lazy first-request
 * error.
 */
export function buildDiditClientFromEnv(env: Parameters<typeof loadDiditConfig>[0]): DiditClient {
  return createDiditClient({ config: loadDiditConfig(env) });
}
