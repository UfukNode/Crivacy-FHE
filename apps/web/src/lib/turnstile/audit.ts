/**
 * Centralized audit emit for Turnstile (bot-gate) verification failures.
 *
 * F-A1-J6-001 — every credential-accepting public route that gates on
 * Turnstile (customer login / register / resend-verification /
 * forgot-password, plus firm + admin internal login) MUST log a row
 * when the gate rejects a request. OWASP ASVS V8.6.4 calls bot-detection
 * failure logging out as a forensic primitive: a distributed
 * credential-stuffing burst that bounces off Turnstile would otherwise
 * leave no trace in the audit table because the call never reaches the
 * `*.login.failed` / `*.password_reset_requested` paths.
 *
 * The actor is always `system:turnstile-gate` — no identity has been
 * resolved at this point in the request lifecycle. The submitted
 * identifier (email or username), when present, is hashed with SHA-256
 * before storage so the row never carries raw PII.
 *
 * Single import surface: every route imports `auditTurnstileFailure`
 * and discriminates only via the `audience` argument. The action key
 * is resolved here, not at the call site, so a future audience
 * addition is one switch case rather than another grep across the
 * route layer.
 *
 * @module
 */

import type { CrivacyDatabase } from '@/lib/db/client';

import type { AuditAction } from '@/lib/audit/actions';
import { systemActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { noTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { hashEmail } from '@/lib/fraud/blacklist';

/**
 * Closed audience union. Maps to the three Turnstile-failed action
 * keys registered in `lib/audit/actions.ts`. Adding a new audience
 * means (1) registering the matching action key, (2) extending this
 * union, (3) adding a `case` to `actionFor`. The compiler enforces
 * step 3 via the exhaustive switch.
 */
export type TurnstileAuditAudience = 'customer' | 'firm_user' | 'admin_user';

function actionFor(audience: TurnstileAuditAudience): AuditAction {
  switch (audience) {
    case 'customer':
      return 'customer.login.turnstile_failed';
    case 'firm_user':
      return 'firm_user.login.turnstile_failed';
    case 'admin_user':
      return 'admin_user.login.turnstile_failed';
  }
}

export interface TurnstileAuditCtx {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
  readonly now: Date;
}

export interface AuditTurnstileFailureOptions {
  /** Routing slug — `'login' | 'register' | 'resend-verification' | 'forgot-password'`. Stored under `meta.endpoint`. */
  readonly endpoint: string;
  /** `error-codes[]` returned by `verifyTurnstileToken` — Cloudflare diagnostic strings. Empty array allowed. */
  readonly turnstileErrorCodes: readonly string[];
  /**
   * The submitted email / username, when the body parsed before
   * verification. Hashed (SHA-256) before storage; if omitted the
   * audit row carries no identifier — useful when the token check
   * happens before body parsing.
   */
  readonly identifier?: string | null;
}

/**
 * Emit a single `<audience>.login.turnstile_failed` audit row. Caller
 * fires this **before** returning the 403 response, inside the same
 * try/catch as the rest of the handler — `writeAudit` failures bubble
 * up as `AuditError` and the route's error mapper turns them into a
 * 500. Auto-idempotent: one row per request, no DB state to race
 * against.
 */
export async function auditTurnstileFailure(
  db: CrivacyDatabase,
  ctx: TurnstileAuditCtx,
  audience: TurnstileAuditAudience,
  opts: AuditTurnstileFailureOptions,
): Promise<void> {
  await writeAudit(db, {
    action: actionFor(audience),
    actor: systemActor('turnstile-gate'),
    target: noTarget(),
    context: buildAuditContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }),
    meta: {
      endpoint: opts.endpoint,
      turnstileErrorCodes: opts.turnstileErrorCodes,
      ...(opts.identifier ? { identifierHash: hashEmail(opts.identifier) } : {}),
    },
    ts: ctx.now,
  });
}
