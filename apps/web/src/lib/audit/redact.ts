/**
 * Read-time PII redaction for audit meta payloads.
 *
 * Write-time redaction is dangerous: once stripped, the original
 * value is gone forever and legitimate incident response cannot
 * reconstruct what happened. We therefore store the raw payload (up
 * to `MAX_META_BYTES`) and redact at read time based on who is
 * asking.
 *
 * Audiences:
 *   * `firm` — a firm user viewing their own firm's audit events.
 *     Sees everything except admin-private fields.
 *   * `admin` — a platform admin viewing any event. Sees the full
 *     payload. Admin impersonation events themselves are tagged so
 *     the pipeline can still redact them if needed downstream.
 *   * `public` — a public export (status page, compliance stream).
 *     All PII is redacted.
 *   * `compliance` — a GDPR/KVKK export. PII is left intact but
 *     wrapped in a marker so the receiving pipeline knows to treat
 *     it as regulated data.
 *
 * The redaction policy is declarative: each field path (dot-joined)
 * maps to a `RedactAction` that says how to treat the value at that
 * path. Unknown paths are left intact at `firm`/`admin`/`compliance`
 * audiences and fully redacted at `public`.
 *
 * Redaction never mutates the input — every `redactMeta` call returns
 * a fresh value.
 */

import { createHash } from 'node:crypto';

export type RedactAudience = 'firm' | 'admin' | 'public' | 'compliance';

export type RedactAction =
  /** Replace with the literal string `'[REDACTED]'`. */
  | 'redact'
  /** Replace with `'[HASH:<first 12 hex chars of sha-256>]'`. */
  | 'hash'
  /** Keep only the first `preserveChars` characters + `'…'`. */
  | { readonly kind: 'truncate'; readonly preserveChars: number }
  /** Replace with the original value only when the audience is allowed. */
  | { readonly kind: 'audience'; readonly allow: readonly RedactAudience[] }
  /** Leave untouched. */
  | 'keep';

const DEFAULT_RULES: Readonly<Record<string, RedactAction>> = Object.freeze({
  // ---------- Direct PII ----------
  email: { kind: 'truncate', preserveChars: 3 } as const,
  phone: 'redact',
  phone_number: 'redact',
  first_name: 'redact',
  last_name: 'redact',
  full_name: 'redact',
  date_of_birth: 'redact',
  dob: 'redact',
  address: 'redact',
  street_address: 'redact',
  postal_code: 'redact',
  national_id: 'hash',
  document_number: 'hash',
  ssn: 'hash',
  // ---------- Secrets ----------
  password: 'redact',
  secret: 'redact',
  token: 'redact',
  api_key: 'redact',
  signing_secret: 'redact',
  authorization: 'redact',
  cookie: 'redact',
  // ---------- Admin-private ----------
  admin_note: { kind: 'audience', allow: ['admin', 'compliance'] } as const,
  impersonation_target: { kind: 'audience', allow: ['admin', 'compliance'] } as const,
  // ---------- chain / crypto (safe to show) ----------
  contract_id: 'keep',
  tx_id: 'keep',
  package_id: 'keep',
  proof_hash: 'keep',
} satisfies Record<string, RedactAction>);

/**
 * Merge the user-supplied rule overrides onto the defaults. Used by
 * tests and by future feature flags that want to ship a per-firm
 * custom redaction policy.
 */
export function mergeRedactionRules(
  overrides: Readonly<Record<string, RedactAction>>,
): Readonly<Record<string, RedactAction>> {
  return Object.freeze({ ...DEFAULT_RULES, ...overrides });
}

export interface RedactOptions {
  /** Audience viewing the meta row. Required — there is no safe default. */
  readonly audience: RedactAudience;
  /** Override rules, merged onto the defaults. */
  readonly rules?: Readonly<Record<string, RedactAction>>;
  /**
   * When true, every unknown key at the `public` audience is also
   * redacted. Defaults to true because the public surface should be
   * fail-closed.
   */
  readonly publicFailClosed?: boolean;
}

/**
 * Apply redaction rules to a meta payload. Returns a new object;
 * the input is not mutated. Nested objects are walked recursively.
 * Arrays of scalars are either kept (if the parent path is `keep`)
 * or mapped element-wise.
 */
export function redactMeta(
  meta: Readonly<Record<string, unknown>>,
  options: RedactOptions,
): Record<string, unknown> {
  const rules = options.rules ?? DEFAULT_RULES;
  const publicFailClosed = options.publicFailClosed ?? true;
  return walkObject(meta, '', rules, options.audience, publicFailClosed);
}

function walkObject(
  input: Readonly<Record<string, unknown>>,
  pathPrefix: string,
  rules: Readonly<Record<string, RedactAction>>,
  audience: RedactAudience,
  publicFailClosed: boolean,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const childPath = pathPrefix === '' ? key : `${pathPrefix}.${key}`;
    const action = lookupAction(childPath, key, rules, audience, publicFailClosed);
    output[key] = applyAction(value, action, childPath, rules, audience, publicFailClosed);
  }
  return output;
}

function lookupAction(
  fullPath: string,
  leafKey: string,
  rules: Readonly<Record<string, RedactAction>>,
  audience: RedactAudience,
  publicFailClosed: boolean,
): RedactAction {
  // Prefer full-path match ("actor.email"), then fall back to leaf
  // key match ("email"). This lets callers write coarse "email"
  // rules that still apply no matter where `email` appears in the
  // tree.
  const full = rules[fullPath];
  if (full !== undefined) {
    return full;
  }
  const leaf = rules[leafKey];
  if (leaf !== undefined) {
    return leaf;
  }
  if (audience === 'public' && publicFailClosed) {
    return 'redact';
  }
  return 'keep';
}

function applyAction(
  value: unknown,
  action: RedactAction,
  pathPrefix: string,
  rules: Readonly<Record<string, RedactAction>>,
  audience: RedactAudience,
  publicFailClosed: boolean,
): unknown {
  if (action === 'keep') {
    if (isPlainObject(value)) {
      return walkObject(value, pathPrefix, rules, audience, publicFailClosed);
    }
    if (Array.isArray(value)) {
      return value.map((item, i) =>
        applyAction(item, 'keep', `${pathPrefix}[${String(i)}]`, rules, audience, publicFailClosed),
      );
    }
    return value;
  }
  if (action === 'redact') {
    return '[REDACTED]';
  }
  if (action === 'hash') {
    return hashValue(value);
  }
  if (typeof action === 'object' && action.kind === 'truncate') {
    return truncateValue(value, action.preserveChars);
  }
  if (typeof action === 'object' && action.kind === 'audience') {
    if (action.allow.includes(audience)) {
      if (isPlainObject(value)) {
        return walkObject(value, pathPrefix, rules, audience, publicFailClosed);
      }
      return value;
    }
    return '[REDACTED]';
  }
  return '[REDACTED]';
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateValue(value: unknown, preserveChars: number): string {
  if (typeof value !== 'string') {
    return '[REDACTED]';
  }
  if (value.length <= preserveChars) {
    return `${value}…`;
  }
  return `${value.slice(0, preserveChars)}…`;
}

/**
 * Hash a value with SHA-256 and return a short prefix tag. We use
 * the Node built-in `crypto` rather than `@node-rs/blake3` to keep
 * this module dependency-light; audit redaction is not on the hot
 * path.
 */
function hashValue(value: unknown): string {
  const serialized = serializeForHash(value);
  const digest = createHash('sha256').update(serialized).digest('hex');
  return `[HASH:${digest.slice(0, 12)}]`;
}

function serializeForHash(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return 'null';
  }
  // Sort keys for deterministic hashing of structural values.
  return JSON.stringify(value, (_key, child: unknown) => {
    if (isPlainObject(child)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(child).sort()) {
        sorted[k] = child[k];
      }
      return sorted;
    }
    return child;
  });
}
