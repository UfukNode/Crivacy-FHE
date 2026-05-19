/**
 * Didit inbound webhook handler — processes KYC decisions from Didit.
 *
 * This handler receives webhooks from Didit's V3 API, verifies the HMAC
 * signature, and updates the corresponding KYC session status. When a
 * session is approved, the handler enqueues a `credential-pipeline`
 * pg-boss job that mints a credential asynchronously. When a
 * session is declined with fraud signals, the customer is permanently
 * banned via the fraud ban orchestrator.
 *
 * Two vendor_data shapes are supported (parsing is delegated to the
 * canonical `parseSessionVendorData` helper in `lib/didit/vendor-data.ts`
 * — single source of truth shared with the face-match cascade lookup):
 *
 * Both shapes resolve to a single unified `kyc_sessions` table after
 * Sprint 7 Phase A+B; the discriminator is the `kind` column, with
 * row-level filtering applied per handler:
 *
 *   * **Customer sessions** — JSON-stringified
 *     `{ crivacySessionId, type: 'customer', customerId }`; the row
 *     is looked up in `kycSessions WHERE kind = 'customer'`.
 *
 *   * **B2B sessions** — JSON-stringified
 *     `{ crivacySessionId, type: 'b2b', firmId, userRef }`; the row
 *     is looked up in `kycSessions WHERE kind = 'b2b'`.
 *
 * @module
 */

import type { NextResponse } from 'next/server';

import { systemActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { noTarget, uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import type { DiditConfig } from '@crivacy-fhe/adapter-didit/config';
import { getDiditConfig } from '@crivacy-fhe/adapter-didit/config';
import { DiditError } from '@crivacy-fhe/adapter-didit/errors';
import type { WebhookBody } from '@crivacy-fhe/adapter-didit/schemas';
import { resolveWorkflowType } from '@crivacy-fhe/adapter-didit/session';
import {
  isDiditOutOfScopeWebhookType,
  isDiditUserEntityWebhookType,
} from '@crivacy-fhe/adapter-didit/types';
import { mapDiditStatusToInternal } from '@crivacy-fhe/adapter-didit/status-mapping';
import { verifyWebhook } from '@crivacy-fhe/adapter-didit/webhook';
import { kycResetCustomerPatch, revokeActiveKycSessions } from '@/lib/customer/kyc-reset';
import { getRootLogger } from '@/lib/observability/logger';
import {
  classifyDecision,
  extractFraudSignals,
  pickFraudReason,
  banCustomer,
  applyFaceMatchSideEffects,
  evaluateFaceMatchFromDecision,
  incrementDecline,
  revokeActiveCredentials,
  type FaceMatchEvaluation,
} from '@/lib/fraud';
import { hydrateDecisionFromWebhookBody } from '@crivacy-fhe/adapter-didit/session';
import type { DiditDecisionPayload } from '@crivacy-fhe/adapter-didit/types';
import {
  parseSessionVendorData,
  type ParsedSessionVendorData,
} from '@crivacy-fhe/adapter-didit/vendor-data';

import { createNotification } from '@/lib/notification';
import { notify } from '@/lib/notification/dispatcher';
import { kycStatusChangeEmail, type KycStatusAction } from '@/lib/email/templates';

import type { RequestContext } from '../context';
import type { WebhookInput } from '../middleware/webhook-route';
import { updateSessionStatus } from '../repositories';

// ---------------------------------------------------------------------------
// Vendor data parsing
// ---------------------------------------------------------------------------

/**
 * Local alias for the canonical `ParsedSessionVendorData` (single
 * source of truth in `lib/didit/vendor-data.ts`). Webhook code reads
 * `crivacySessionId` from this; the `firmId` / `userRef` fields on
 * the B2B branch are unused here but exist on the canonical type
 * because the face-match cascade lookup reads them.
 */
type ParsedVendorData = ParsedSessionVendorData;

function parseVendorData(body: Record<string, unknown>): ParsedVendorData | null {
  return parseSessionVendorData(body['vendor_data']);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /api/webhooks/didit — inbound Didit webhook receiver.
 *
 * Flow:
 *   1. Verify HMAC signature (V2 preferred, Simple fallback)
 *   2. Parse the webhook body for the session ID (B2B or customer)
 *   3. Look up the KYC session in our database
 *   4. Update session status based on Didit decision
 *   5. If rejected -> classify as normal_decline or fraud
 *      5a. If fraud -> ban customer via banCustomer()
 *      5b. If normal_decline -> allow retry (up to max attempts)
 *   6. If approved -> enqueue credential-pipeline pg-boss job
 *   7. Always return 200 to prevent Didit retries
 *
 * Errors after HMAC verification are logged but swallowed — we always
 * return 200 to avoid Didit's retry storm on persistent failures.
 */
export async function handleDiditWebhook(
  ctx: RequestContext,
  input: WebhookInput,
): Promise<NextResponse> {
  // --- 1. Verify HMAC signature ---
  let config: DiditConfig;
  try {
    config = getDiditConfig();
  } catch {
    // Config not available — reject
    getRootLogger().error(
      { event: 'didit_webhook_config_missing' },
      'Didit config not loaded',
    );
    return ctx.json({ received: true, error: 'configuration_unavailable' });
  }

  try {
    const verified = verifyWebhook(config, {
      body: input.body,
      headers: input.headers,
    });

    // Signature valid — process the payload
    const webhookBody = verified.body;
    const webhookType = webhookBody.webhook_type;

    // --- Event-type routing (Didit emits 9 documented event types) ---
    //
    // `status.updated` / `data.updated`         — session-level events
    //                                             (default flow below).
    // `user.status.updated` / `user.data.updated` — user-entity events
    //                                             (delete + ACTIVE/FLAGGED/
    //                                             BLOCKED status changes);
    //                                             handled by Batch E.
    // `business.*` / `transaction.*` / `activity.created`
    //                                           — out of scope for this
    //                                             integration today; we
    //                                             200-ack with an
    //                                             observability log so
    //                                             Didit does not retry
    //                                             indefinitely.
    //
    // Source of truth: Didit docs: 26_webhooks.md
    //                  + api-references/management-api_users_*.md
    if (isDiditUserEntityWebhookType(webhookType)) {
      return handleUserEntityWebhook(ctx, webhookBody);
    }
    if (isDiditOutOfScopeWebhookType(webhookType)) {
      getRootLogger().info(
        {
          event: 'didit_webhook_out_of_scope_event',
          webhookType,
        },
        'Didit webhook event type is not handled by this integration',
      );
      return ctx.json({ received: true });
    }

    // Session-level event from here on. Schema's superRefine has
    // already enforced session_id + workflow_id + status presence,
    // but we narrow defensively in case the schema is ever loosened
    // further or a future event type slips past the routing above.
    if (
      webhookBody.session_id === undefined ||
      webhookBody.workflow_id === undefined ||
      webhookBody.status === undefined
    ) {
      getRootLogger().error(
        {
          event: 'didit_webhook_session_event_missing_fields',
          webhookType,
        },
        'Session-level webhook missing required fields after schema parse',
      );
      return ctx.json({ received: true });
    }
    const diditSessionId = webhookBody.session_id;
    const status = webhookBody.status;

    // F-KYC-A2-B-001: webhook workflow_id whitelist (defense in depth).
    // HMAC verification proves the body came from Didit, but Didit may
    // also be configured with workflows we never wired (operator side
    // misconfiguration: a third workflow created in the Didit Console
    // and pointed at our callback URL). The session-create path
    // already guards against this with `resolveWorkflowType`; we run
    // the same guard here so the receive-side honours the same
    // contract. `failClosedOnUnknownWorkflow` (default true) → log
    // + 200 ack so Didit does not retry, leaving SOC to triage.
    try {
      resolveWorkflowType(config, webhookBody.workflow_id);
    } catch (workflowErr) {
      getRootLogger().warn(
        {
          event: 'didit_webhook_unknown_workflow',
          workflowId: webhookBody.workflow_id,
          diditSessionId,
          err:
            workflowErr instanceof Error
              ? { name: workflowErr.name, message: workflowErr.message }
              : String(workflowErr),
        },
        'Didit webhook workflow_id is not configured for this deployment',
      );
      return ctx.json({ received: true });
    }

    // --- 2. Parse vendor_data to determine session type ---
    //
    // Moved ahead of the status lookup so the unknown-status
    // branch below can record WHICH session the unhandled
    // payload belongs to, rather than dropping it on the floor
    // with only a console line.
    const body = input.body as Record<string, unknown>;
    const vendorData = parseVendorData(body);
    if (vendorData === null) {
      getRootLogger().error(
        { event: 'didit_webhook_vendor_data_parse_failed' },
        'Could not parse vendor_data from webhook body',
      );
      return ctx.json({ received: true });
    }

    // --- 3. Map Didit status to our internal session status ---
    //
    // Mapping table + rationale lives in `lib/didit/status-mapping.ts`
    // (single source of truth — push-channel here, pull-fallback in
    // customer-kyc.ts, drift reconciler in kyc-reconciler-worker.ts
    // all import the same `mapDiditStatusToInternal`).
    const mappedStatus = mapDiditStatusToInternal(status);

    if (mappedStatus === null) {
      // Didit shipped a status value we have not wired through
      // `statusMap` yet. The webhook schema no longer enum-locks
      // the status field so the handler is the authoritative
      // arbiter: persist the decision payload for manual triage,
      // stamp an audit row so the SOC dashboard surfaces it, and
      // acknowledge with 200 so Didit does not retry indefinitely
      // against a configuration the operator has to update.
      //
      // The session's logical status is intentionally NOT flipped
      // to anything speculative — leaving it at its last known
      // state lets the eventual follow-up delivery (once we map
      // the new value) advance it cleanly. Session may be null if
      // the row doesn't exist (race / stale webhook); the audit
      // row still fires with `noTarget()` so the signal is not
      // lost.
      const sessionId = await persistUnknownStatusPayload(
        ctx,
        vendorData,
        diditSessionId,
        input.body,
      );

      // Audit target: the existing enum has `kyc_session` (B2B
      // table) and `customer` (the end-user row). We use the one
      // that matches the payload's flavour so the audit log stays
      // queryable without adding a new enum value. The B2B and
      // customer session UUIDs go into the `meta` payload when
      // they do not match the chosen kind.
      const auditTarget = (() => {
        if (sessionId === null) return noTarget();
        if (vendorData.type === 'b2b') {
          return uuidTarget({ kind: 'kyc_session', id: sessionId });
        }
        // Customer flow — scope the target to the customer row so
        // the audit log's "subject" column points at the user the
        // unmapped status was about.
        return uuidTarget({ kind: 'customer', id: vendorData.customerId });
      })();

      await writeAudit(ctx.db, {
        action: 'kyc_session.webhook_unknown_status',
        actor: systemActor('didit-webhook'),
        target: auditTarget,
        context: buildAuditRequestContext({
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
          requestId: ctx.requestId,
        }),
        meta: {
          rawStatus: status,
          diditSessionId,
          vendorType: vendorData.type,
          crivacySessionId: sessionId,
          webhookType: typeof body['webhook_type'] === 'string' ? body['webhook_type'] : null,
        },
        ts: ctx.now,
      }).catch((auditErr) => {
        // Audit failure must not turn into a 5xx (Didit would
        // retry). The payload is already persisted on the session
        // row; the audit gap is a SOC observability concern, not
        // a correctness one.
        getRootLogger().error(
          {
            event: 'didit_webhook_audit_write_failed',
            phase: 'unknown_status',
            err: auditErr instanceof Error
              ? { name: auditErr.name, message: auditErr.message }
              : String(auditErr),
          },
          'didit-webhook audit write failed for unknown_status',
        );
      });

      getRootLogger().warn(
        {
          event: 'didit_webhook_unknown_status',
          rawStatus: status,
          sessionId,
        },
        `Unrecognised Didit status "${status}" persisted; mapping required`,
      );
      return ctx.json({ received: true });
    }

    // --- 4. Route to B2B or customer handler ---
    if (vendorData.type === 'customer') {
      return handleCustomerWebhook(ctx, {
        diditSessionId,
        mappedStatus,
        customerSessionId: vendorData.crivacySessionId,
        customerId: vendorData.customerId,
        webhookBody: input.body,
      });
    }

    // --- B2B path ---
    return handleB2bWebhook(ctx, {
      diditSessionId,
      mappedStatus,
      b2bSessionId: vendorData.crivacySessionId,
      webhookBody: input.body,
    });
  } catch (err) {
    if (err instanceof DiditError) {
      // Signature verification failed
      if (
        err.code === 'missing_signature' ||
        err.code === 'invalid_signature' ||
        err.code === 'stale_signature' ||
        err.code === 'missing_timestamp' ||
        err.code === 'timestamp_mismatch'
      ) {
        return ctx.errorJson('webhook_signature_invalid', err.message, 401);
      }
      if (err.code === 'invalid_webhook_body') {
        return ctx.errorJson('validation_failed', err.message, 400);
      }
    }

    // Unknown error — log and return 200 to prevent retries
    getRootLogger().error(
      {
        event: 'didit_webhook_unexpected_error',
        err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      },
      'didit-webhook unexpected error',
    );
    return ctx.json({ received: true });
  }
}

/**
 * Record a verified-but-unmappable webhook payload on the session
 * row so it does not vanish into the void. Returns the session
 * UUID the payload was attached to, or `null` when no matching
 * row was found (so the caller can still stamp a `noTarget()`
 * audit row with the diagnostic metadata).
 *
 * Only the `didit_decision_payload` + `updated_at` columns are
 * touched — the session's logical `status` is intentionally
 * preserved. A follow-up redelivery with a status value we DO
 * understand will advance the row through the normal handler
 * paths; we do not want a speculative write here to collide with
 * that.
 */
async function persistUnknownStatusPayload(
  ctx: RequestContext,
  vendorData: ParsedVendorData,
  diditSessionId: string,
  rawBody: unknown,
): Promise<string | null> {
  // Sprint 7 Phase D: unified table read+write. Both customer and b2b
  // sessions live in `kyc_sessions` after Phase B's backfill + dual-write
  // trigger; the kind discriminator filters per-flow when defensive
  // narrowing is needed (here we don't need to — both kinds get the
  // same payload-persist treatment, just locate the row by didit_session_id
  // first, then by the canonical id from vendor_data as a fallback).
  const { eq, or } = await import('drizzle-orm');
  const schema = await import('@/lib/db/schema');

  try {
    const rows = await ctx.db
      .select({ id: schema.kycSessions.id })
      .from(schema.kycSessions)
      .where(
        or(
          eq(schema.kycSessions.diditSessionId, diditSessionId),
          eq(schema.kycSessions.id, vendorData.crivacySessionId),
        ),
      )
      .limit(1);

    const session = rows[0];
    if (session === undefined) return null;

    await ctx.db
      .update(schema.kycSessions)
      .set({
        diditDecisionPayload: rawBody as Record<string, unknown>,
        updatedAt: ctx.now,
      })
      .where(eq(schema.kycSessions.id, session.id));

    return session.id;
  } catch (err) {
    // DB failure during the persist is non-fatal — the audit row
    // still captures the payload metadata and the webhook still
    // acknowledges with 200. Re-raising would trip a Didit retry
    // storm against a DB that is already unhappy.
    getRootLogger().error(
      {
        event: 'didit_webhook_persist_unknown_status_failed',
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      'persistUnknownStatusPayload failed',
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// User-entity webhook sub-handler (Batch E)
// ---------------------------------------------------------------------------

/**
 * Reduce a `user.*` webhook body to one of the four high-level actions
 * the handler knows how to take. The reduction is the single point
 * where Didit's two competing status enums (`ACTIVE/FLAGGED/BLOCKED`
 * from `entities_users_overview.md` vs `Approved/Declined/In Review/
 * Pending` from the OpenAPI schemas) are normalised — both enum sets
 * are accepted because Didit's docs are inconsistent and the live wire
 * format may use either.
 *
 *   * `revoke`   — terminal: user is gone (deleted) or blocked. Run
 *                  the full revoke pipeline (credential, kyc
 *                  level reset, PII scrub, audit, firm webhook).
 *   * `flag`     — soft signal: Didit flagged the user for manual
 *                  review. Audit + in-app notification, no revoke.
 *   * `noop`     — only metadata changed (display_name etc.). Audit
 *                  the noop and 200-ack so we have an observability
 *                  trail.
 *   * `unknown`  — webhook_type was user.* but neither deletion nor a
 *                  recognised status transition fired. Audit + 200.
 */
type UserEntityAction =
  | { kind: 'revoke'; reason: 'deleted' | 'blocked' }
  | { kind: 'flag'; reason: 'flagged' }
  | { kind: 'noop'; changedFields: readonly string[] }
  | { kind: 'unknown' };

function reduceUserEntityWebhook(body: WebhookBody): UserEntityAction {
  const wt = body.webhook_type;

  // --- user.data.updated → check for deletion signal ---
  if (wt === 'user.data.updated') {
    // Top-level deleted_at (per management-api_users_delete.md:32 —
    // "Emits a user.data.updated webhook with deleted_at set"; the
    // doc does not pin the path, so we read both top-level and
    // changes.current.deleted_at defensively).
    if (typeof body.deleted_at === 'string' && body.deleted_at.length > 0) {
      return { kind: 'revoke', reason: 'deleted' };
    }
    // Nested under changes.current.deleted_at
    const currentDeletedAt = body.changes?.current?.['deleted_at'];
    if (typeof currentDeletedAt === 'string' && currentDeletedAt.length > 0) {
      return { kind: 'revoke', reason: 'deleted' };
    }
    // changed_fields[] mentions deleted_at — fallback signal in case
    // Didit ships only the field-name list without echoing the value
    const changedFields = body.changed_fields ?? [];
    if (changedFields.includes('deleted_at')) {
      return { kind: 'revoke', reason: 'deleted' };
    }
    // No deletion → metadata change (display_name, tier, tags, ...)
    return { kind: 'noop', changedFields };
  }

  // --- user.status.updated → map both enum systems to one decision ---
  if (wt === 'user.status.updated') {
    const status = body.status;
    if (status === undefined) return { kind: 'unknown' };

    // Both enum systems accepted (Didit docs are inconsistent — see
    // schema docblock). BLOCKED / Declined → terminal revoke.
    // FLAGGED / In Review → soft flag (audit, no revoke).
    // ACTIVE / Approved / Pending / unknown → noop (no state damage).
    if (status === 'BLOCKED' || status === 'Declined') {
      return { kind: 'revoke', reason: 'blocked' };
    }
    if (status === 'FLAGGED' || status === 'In Review') {
      return { kind: 'flag', reason: 'flagged' };
    }
    return { kind: 'noop', changedFields: [] };
  }

  return { kind: 'unknown' };
}

/**
 * Handler for `user.status.updated` and `user.data.updated` webhook
 * events. These fire on user-entity changes (delete, status flip,
 * profile metadata update) and are independent of any specific
 * verification session.
 *
 * Flow:
 *   1. Reduce body → one of {revoke, flag, noop, unknown}
 *   2. Parse vendor_data to find our customer (only customer-flow
 *      sessions carry the JSON shape we wrote at create time; B2B
 *      flows attach vendor_data per session, not per user, so they
 *      do not show up on user.* events)
 *   3. Idempotency: if the customer is already in the post-revoke
 *      terminal state, 200-ack without further work
 *   4. revoke → run the existing revoke pipeline (mirror of
 *      `customer.kyc_expired` branch in `handleCustomerWebhook`)
 *   5. flag → audit + in-app notification, no state change
 *   6. noop / unknown → audit-only, 200-ack
 *
 * Errors are caught and logged; the handler always returns 200 so
 * Didit does not enter a retry storm against a payload we already
 * recorded.
 */
async function handleUserEntityWebhook(
  ctx: RequestContext,
  webhookBody: WebhookBody,
): Promise<NextResponse> {
  const action = reduceUserEntityWebhook(webhookBody);
  const webhookType = webhookBody.webhook_type;
  const vendorUserId =
    typeof webhookBody.vendor_user_id === 'string' ? webhookBody.vendor_user_id : null;

  // Step 1: parse vendor_data → find our customer.
  const vendorData = parseVendorData(webhookBody as unknown as Record<string, unknown>);
  if (vendorData === null || vendorData.type !== 'customer') {
    // Either no vendor_data, malformed, or a B2B namespace value (B2B
    // sessions are firm-scoped and do not represent a single customer
    // entity in our database — nothing to revoke).
    getRootLogger().warn(
      {
        event: 'didit_webhook_user_entity_no_customer_anchor',
        webhookType,
        vendorUserId,
        actionKind: action.kind,
      },
      'user.* webhook arrived without a customer-flow vendor_data anchor',
    );
    await writeAudit(ctx.db, {
      action: 'kyc_session.webhook_unknown_status',
      actor: systemActor('didit-webhook'),
      target: noTarget(),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        reason: 'user_entity_webhook_no_customer_anchor',
        webhookType: webhookType ?? null,
        actionKind: action.kind,
        vendorUserId,
      },
      ts: ctx.now,
    }).catch(() => {
      // audit-write failure must not flip to 5xx — Didit retry storm.
    });
    return ctx.json({ received: true });
  }

  const customerId = vendorData.customerId;

  // Step 2: confirm customer exists in our DB.
  const { eq } = await import('drizzle-orm');
  const schemaModule = await import('@/lib/db/schema');
  const customerRows = await ctx.db
    .select({
      id: schemaModule.customers.id,
      kycLevel: schemaModule.customers.kycLevel,
    })
    .from(schemaModule.customers)
    .where(eq(schemaModule.customers.id, customerId))
    .limit(1);
  const customer = customerRows[0];
  if (customer === undefined) {
    // Orphan: vendor_data points at a customer that does not exist
    // (deleted on our side already, or test-environment leakage).
    getRootLogger().warn(
      {
        event: 'didit_webhook_user_entity_orphan_customer',
        webhookType,
        vendorUserId,
        customerId,
        actionKind: action.kind,
      },
      'user.* webhook references a customer that is not in our DB',
    );
    await writeAudit(ctx.db, {
      action: 'kyc_session.webhook_unknown_status',
      actor: systemActor('didit-webhook'),
      target: noTarget(),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        reason: 'user_entity_webhook_orphan_customer',
        webhookType: webhookType ?? null,
        actionKind: action.kind,
        vendorUserId,
        customerId,
      },
      ts: ctx.now,
    }).catch(() => {});
    return ctx.json({ received: true });
  }

  // Step 3: branch on action.kind.
  if (action.kind === 'unknown' || action.kind === 'noop') {
    // Audit-only branch. We record the payload's intent (what
    // changed) so SOC can spot a Didit-side enum drift early.
    getRootLogger().info(
      {
        event: 'didit_webhook_user_entity_noop',
        webhookType,
        customerId,
        vendorUserId,
        changedFields: action.kind === 'noop' ? action.changedFields : null,
      },
      'user.* webhook recorded as no-op (no state change)',
    );
    return ctx.json({ received: true });
  }

  if (action.kind === 'flag') {
    // Soft signal — Didit flagged the user for manual review on
    // their side. We audit + log; no credential revoke (a flag may
    // resolve to ACTIVE or BLOCKED later, and we do not want to
    // damage state on a transient signal).
    getRootLogger().info(
      {
        event: 'didit_webhook_user_entity_flagged',
        webhookType,
        customerId,
        vendorUserId,
      },
      'user.* webhook reduced to FLAGGED — audit only, no revoke',
    );
    return ctx.json({ received: true });
  }

  // Step 4: action.kind === 'revoke' — run the full revoke pipeline.
  //
  // Idempotency: if the customer is already at kyc_0, the revoke
  // pipeline below is a no-op (revokeActiveCredentials returns 0
  // when there are no active credentials; the customer UPDATE is
  // a value-equal write). The audit row + log entry will still
  // fire so SOC sees the duplicate delivery.
  if (customer.kycLevel === 'kyc_0') {
    getRootLogger().info(
      {
        event: 'didit_webhook_user_entity_revoke_replay',
        webhookType,
        customerId,
        vendorUserId,
        reason: action.reason,
      },
      'user.* revoke webhook arrived for already-revoked customer (replay)',
    );
    return ctx.json({ received: true });
  }

  const revokedReasonLabel: 'didit_user_deleted' | 'didit_user_blocked' =
    action.reason === 'deleted' ? 'didit_user_deleted' : 'didit_user_blocked';

  try {
    const revokedCount = await revokeActiveCredentials(
      ctx.db,
      customerId,
      ctx.now,
      revokedReasonLabel,
    );
    getRootLogger().info(
      {
        event: 'didit_webhook_user_entity_revoke_completed',
        webhookType,
        customerId,
        vendorUserId,
        reason: action.reason,
        revokedCount,
      },
      'user.* revoke pipeline completed',
    );

    // Reset the customer's kyc_level + clear PII fields, AND stamp
    // `revoked_at` / `revoked_reason` so the start-identity / start-
    // address handlers know to clear them when the customer
    // initiates a fresh re-verification flow (banner self-clears).
    // Patch base sourced from the shared `kycResetCustomerPatch`
    // helper — same call as the admin reset_kyc and the kyc_expired
    // branch below, so a future PII-column addition only updates
    // one place.
    await ctx.db
      .update(schemaModule.customers)
      .set({
        ...kycResetCustomerPatch(ctx.now),
        revokedAt: ctx.now,
        revokedReason: revokedReasonLabel,
      })
      .where(eq(schemaModule.customers.id, customerId));

    // Bulk-expire any active customer KYC sessions via the canonical
    // helper — same call the admin `reset_kyc`, `Kyc Expired`, and
    // ban paths use. The helper carries the `REVOKABLE_SESSION_STATUSES`
    // SoT internally so the "still touchable?" set lives in exactly
    // one place (`lib/kyc/session-status-display.ts`).
    await revokeActiveKycSessions(
      ctx.db,
      customerId,
      ctx.now,
      `Didit user ${action.reason}`,
    );

    // Audit: customer.kyc_revoked_by_didit_user
    await writeAudit(ctx.db, {
      action: 'customer.kyc_revoked_by_didit_user',
      actor: systemActor('didit-webhook'),
      target: uuidTarget({ kind: 'customer', id: customerId }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        reason: revokedReasonLabel,
        webhookType: webhookType ?? null,
        vendorUserId,
        revokedCredentialCount: revokedCount,
      },
      ts: ctx.now,
    }).catch((auditErr) => {
      // Audit failure must not flip the response to 5xx (Didit retry
      // storm). The state mutation has already landed; a missing
      // audit row is a SOC observability concern, not a correctness
      // one.
      getRootLogger().error(
        {
          event: 'didit_webhook_user_entity_audit_failed',
          customerId,
          err:
            auditErr instanceof Error
              ? { name: auditErr.name, message: auditErr.message }
              : String(auditErr),
        },
        'user.* revoke audit write failed',
      );
    });

    // Firm webhook fan-out — reuse the existing
    // `kyc.session.kyc_expired` event type ("no longer verified"
    // semantics match exactly). Carries `reason` so subscribers can
    // discriminate between TTL expiry and operator revoke.
    try {
      const { emitUserEvent } = await import('@/lib/webhook');
      const selfServiceFirmId = process.env['CRIVACY_SELF_SERVICE_FIRM_ID'] ?? '';
      await emitUserEvent(ctx.db, {
        customerId,
        ownerFirmId: selfServiceFirmId,
        type: 'kyc.session.kyc_expired',
        payload: {
          userRef: customerId,
          expiredAt: ctx.now.toISOString(),
          reason: revokedReasonLabel,
        },
        // sourceSessionId omitted — user-entity revoke is not tied
        // to a specific session (it cancels every active session at
        // once). The bulk-expire UPDATE above leaves the actual
        // session rows in `revoked` state with their own ids; the
        // firm receives one event per customer, not per session.
        idempotencyKey: `kyc.didit_revoke:${customerId}:${ctx.now.toISOString()}`,
        now: ctx.now,
      });
    } catch (webhookErr) {
      getRootLogger().error(
        {
          event: 'didit_webhook_user_entity_firm_dispatch_failed',
          customerId,
          err:
            webhookErr instanceof Error
              ? { name: webhookErr.name, message: webhookErr.message }
              : String(webhookErr),
        },
        'user.* revoke firm webhook dispatch failed',
      );
    }
  } catch (revokeErr) {
    // Best-effort: log + continue. The DB-side row may be partially
    // updated (chain revoke succeeded, customers UPDATE failed, or
    // vice versa); out-of-band reconciliation can pick up any
    // orphaned active credentials. Re-throwing would force Didit
    // into a retry storm against a chain-side state that is not
    // idempotent.
    getRootLogger().error(
      {
        event: 'didit_webhook_user_entity_revoke_failed',
        webhookType,
        customerId,
        vendorUserId,
        reason: action.reason,
        err:
          revokeErr instanceof Error
            ? { name: revokeErr.name, message: revokeErr.message }
            : String(revokeErr),
      },
      'user.* revoke pipeline failed — credential may be orphaned',
    );
  }

  return ctx.json({ received: true });
}

// ---------------------------------------------------------------------------
// B2B webhook sub-handler
// ---------------------------------------------------------------------------

async function handleB2bWebhook(
  ctx: RequestContext,
  params: {
    diditSessionId: string;
    mappedStatus: string;
    b2bSessionId: string;
    webhookBody: unknown;
  },
): Promise<NextResponse> {
  const { and: drizzleAnd, eq } = await import('drizzle-orm');
  const { kycSessions } = await import('@/lib/db/schema');

  // Sprint 7 Phase D — defence-in-depth `kind = 'b2b'` filter on the
  // initial lookup. Even though `params.b2bSessionId` came from a
  // signed B2B vendor_data blob, narrowing on the row's discriminator
  // closes the gap where a bug elsewhere produces a `b2b`-shaped
  // vendor_data referencing a `customer`-kind row. The customer
  // handler does the same with `kind = 'customer'` filtering.
  const rows = await ctx.db
    .select()
    .from(kycSessions)
    .where(
      drizzleAnd(
        eq(kycSessions.kind, 'b2b' as const),
        eq(kycSessions.id, params.b2bSessionId),
      ),
    )
    .limit(1);

  const rawSession = rows[0];
  if (rawSession === undefined) {
    getRootLogger().error(
      { event: 'didit_webhook_b2b_session_not_found', b2bSessionId: params.b2bSessionId },
      'B2B session not found',
    );
    return ctx.json({ received: true });
  }

  // Sprint 7 Phase F — runtime narrow to B2bKycSession. The lookup
  // above already filtered to `kind='b2b'` rows, and the
  // `kyc_sessions_kind_invariant` CHECK constraint guarantees b2b
  // rows have non-null firmId/userRef/level/createdByApiKeyId. The
  // type assertion mirrors the runtime invariant so the b2b-only
  // downstream consumers (face-match dispatch, firm webhook fan-out,
  // pipeline enqueue) keep their `string` typings without an `??`
  // fallback that would mask a corrupt-row scenario.
  const session = rawSession as typeof rawSession & {
    firmId: string;
    userRef: string;
    level: NonNullable<typeof rawSession.level>;
    createdByApiKeyId: string;
  };

  // -----------------------------------------------------------------
  // Sprint 6 — Face-match cascade evaluation (B2B branch)
  // -----------------------------------------------------------------
  //
  // Same evaluator as the customer handler, but the context is
  // `firmId + userRef` (B2B sessions have no first-class user
  // account). On `cascade_fraud`, the cascade-ban orchestrator
  // inserts a face_hash blacklist row + audit; no customer status
  // flip (there is no customer record). On `block_toast`, only the
  // audit row fires; the firm gets the standard rejected webhook
  // with a face-match-specific reason. `reuse` is logged as a
  // Sprint 6 follow-up; the duplicate-mint risk is bounded by the
  // worker's `(firmId, userRef)` dedup.
  let faceMatchEval: FaceMatchEvaluation | null = null;
  let faceMatchOverrideReason: 'fraud_cascade' | 'face_match_blocked' | null = null;
  let hydratedDecisionForCascade: DiditDecisionPayload | null = null;
  if (params.mappedStatus === 'approved' || params.mappedStatus === 'rejected') {
    let faceMatchConfig: DiditConfig | null = null;
    try {
      faceMatchConfig = getDiditConfig();
    } catch {
      // unreachable in practice — verifier upstream loaded it.
    }
    if (faceMatchConfig !== null) {
      const decision = hydrateDecisionFromWebhookBody(faceMatchConfig, params.webhookBody);
      if (decision !== null) {
        hydratedDecisionForCascade = decision;
        const result = await evaluateFaceMatchFromDecision(ctx.db, decision, {
          kind: 'b2b',
          firmId: session.firmId,
          userRef: session.userRef,
        });
        if (result !== null) {
          faceMatchEval = result.evaluation;
          if (result.overrideReason !== null) {
            faceMatchOverrideReason = result.overrideReason;
          } else if (result.evaluation.kind === 'reuse') {
            getRootLogger().info(
              {
                event: 'didit_webhook_b2b_face_match_reuse_pending_impl',
                firmId: session.firmId,
                userRef: session.userRef,
                sessionId: session.id,
              },
              'Sprint 6 reuse branch (B2B) — disclose path not yet implemented; continuing with normal mint',
            );
          }
        }
      }
    }
  }

  // Effective status — face-match override demotes Approved to
  // Rejected. The Didit-mapped status (`params.mappedStatus`) is
  // still used as the audit / firm-webhook discriminant for legacy
  // observability, but the persisted row reflects the override.
  const effectiveStatus =
    faceMatchOverrideReason !== null ? 'rejected' : params.mappedStatus;
  const isTerminal = effectiveStatus === 'approved' || effectiveStatus === 'rejected';

  const extra: {
    completedAt?: Date;
    failureReason?: string;
    diditSessionId?: string;
    diditDecisionPayload?: unknown;
  } = {
    diditSessionId: params.diditSessionId,
    diditDecisionPayload: params.webhookBody,
  };
  if (isTerminal) {
    extra.completedAt = ctx.now;
  }
  if (effectiveStatus === 'rejected') {
    extra.failureReason = faceMatchOverrideReason ?? 'Declined by Didit';
  }

  await updateSessionStatus(ctx.db, session.id, effectiveStatus as typeof session.status, {
    ...extra,
    kind: 'b2b',
  });

  // Sprint 6 cascade-ban + face-match-blocked audit + IP-abuse
  // counter increment. The captured IP is the END-USER's (Didit's
  // hosted flow ran in the user's browser), not the firm's API
  // server, so the same gate applies regardless of B2B vs customer.
  if (faceMatchEval !== null && hydratedDecisionForCascade !== null) {
    await applyFaceMatchSideEffects(ctx.db, {
      evaluation: faceMatchEval,
      context: { kind: 'b2b', firmId: session.firmId, userRef: session.userRef },
      decision: hydratedDecisionForCascade,
      currentDiditSessionId: params.diditSessionId,
      b2bKycSessionId: session.id,
      firmIdForLogging: session.firmId,
      auditContext: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      surface: 'webhook_b2b',
      now: ctx.now,
    });
  }

  // --- B2B terminal-decision routing ---
  //
  // For `approved`: enqueue the B2B credential pipeline. The worker
  // mints the credential, inserts `kyc_credentials_meta` for
  // (firmId, userRef), and emits `kyc.session.approved` with the
  // canonical credential view (blob + proofHash + contractId inline)
  // — exactly the same shape the customer flow has been emitting on
  // `credential.created`. This closes the OAuth↔B2B disparity that
  // pre-Sprint-5 left B2B firms with metadata-only payloads.
  //
  // For `rejected`: there is no credential to mint. Emit
  // `kyc.session.rejected` directly with the legacy minimal shape —
  // session-only, no credential context applies.
  //
  // Pending / in_progress transitions are internal: not emitted.
  // Approval gated on face-match override too — even though Didit
  // said Approved, we don't mint a credential whose face is the
  // anchor for a cascade ban.
  if (effectiveStatus === 'approved' && faceMatchOverrideReason === null) {
    try {
      const { enqueueCredentialPipeline } = await import(
        '@/server/jobs/credential-pipeline-worker'
      );
      const { createQueueClient } = await import('@/server/jobs/queue');

      const connectionString = process.env['DATABASE_URL'];
      if (connectionString !== undefined && connectionString.length > 0) {
        const boss = await createQueueClient(connectionString);
        try {
          const phase = session.workflow === 'identity' ? 'identity' : 'address';
          await enqueueCredentialPipeline(boss, {
            flow: 'b2b',
            kycSessionId: session.id,
            firmId: session.firmId,
            userRef: session.userRef,
            diditSessionId: params.diditSessionId,
            phase,
          });
          getRootLogger().info(
            {
              event: 'didit_webhook_b2b_pipeline_enqueued',
              sessionId: session.id,
              firmId: session.firmId,
              phase,
            },
            'B2B credential pipeline enqueued (mint + emit)',
          );
        } finally {
          await boss.stop();
        }
      } else {
        getRootLogger().error(
          { event: 'didit_webhook_b2b_pipeline_db_url_missing', sessionId: session.id },
          'DATABASE_URL not set — cannot enqueue B2B credential pipeline',
        );
      }
    } catch (enqueueErr) {
      getRootLogger().error(
        {
          event: 'didit_webhook_b2b_pipeline_enqueue_failed',
          sessionId: session.id,
          firmId: session.firmId,
          err: enqueueErr instanceof Error
            ? { name: enqueueErr.name, message: enqueueErr.message }
            : String(enqueueErr),
        },
        'B2B credential pipeline enqueue failed',
      );
    }
  } else if (effectiveStatus === 'rejected') {
    try {
      const { emitFirmEvent } = await import('@/lib/webhook');
      await emitFirmEvent(ctx.db, {
        firmId: session.firmId,
        type: 'kyc.session.rejected',
        payload: {
          sessionId: session.id,
          userRef: session.userRef,
          level: session.level,
          workflow: session.workflow,
          rejectedAt: ctx.now.toISOString(),
          reason: faceMatchOverrideReason ?? 'Declined by Didit',
        },
        sourceSessionId: session.id,
        idempotencyKey: `kyc.session.rejected:${session.id}`,
        now: ctx.now,
      });
    } catch (webhookErr) {
      getRootLogger().error(
        {
          event: 'didit_webhook_b2b_rejected_dispatch_failed',
          sessionId: session.id,
          firmId: session.firmId,
          err: webhookErr instanceof Error
            ? { name: webhookErr.name, message: webhookErr.message }
            : String(webhookErr),
        },
        'B2B kyc.session.rejected dispatch failed',
      );
    }
  }

  // --- Fraud classification for B2B rejections ---
  //
  // Skipped when Sprint 6 cascade already fired. Legacy classifier
  // is observability-only on the B2B side (no auto-ban — there is
  // no customer record to ban) so the duplicate-log avoidance is
  // the only motivation here.
  if (effectiveStatus === 'rejected' && faceMatchOverrideReason !== 'fraud_cascade') {
    try {
      const classification = classifyDecision(params.webhookBody);
      if (classification === 'fraud') {
        const signals = extractFraudSignals(params.webhookBody);
        const signalNames = signals.map((s) => s.name);
        getRootLogger().warn(
          {
            event: 'didit_webhook_b2b_fraud_detected',
            sessionId: session.id,
            firmId: session.firmId,
            signals: signalNames,
          },
          'Fraud detected on B2B session, skipping auto-ban',
        );
      }
    } catch (fraudErr) {
      getRootLogger().error(
        {
          event: 'didit_webhook_b2b_fraud_classify_failed',
          sessionId: session.id,
          err: fraudErr instanceof Error
            ? { name: fraudErr.name, message: fraudErr.message }
            : String(fraudErr),
        },
        'Fraud classification failed (B2B)',
      );
    }
  }

  return ctx.json({ received: true });
}

// ---------------------------------------------------------------------------
// Customer webhook sub-handler
// ---------------------------------------------------------------------------

// Exported for direct unit testing of the ownership guard. Route
// code still only calls `handleDiditWebhook`, which routes into
// this helper after HMAC verification.
export async function handleCustomerWebhook(
  ctx: RequestContext,
  params: {
    diditSessionId: string;
    mappedStatus: string;
    customerSessionId: string;
    customerId: string;
    webhookBody: unknown;
  },
): Promise<NextResponse> {
  const { and: drizzleAnd, eq } = await import('drizzle-orm');
  const { kycSessions } = await import('@/lib/db/schema');

  // Sprint 7 Phase D — read+write the unified `kyc_sessions` table with
  // `kind = 'customer'` filter. Every WHERE clause in this handler keeps
  // the kind narrow so a B2B row sharing a `didit_session_id` (Didit
  // issues globally unique ids, but the partial unique index spans both
  // kinds, so a future enum/schema change wouldn't tighten this on its
  // own) cannot be mutated by the customer-flow path.
  const customerKindFilter = eq(kycSessions.kind, 'customer' as const);

  // Look up by (Didit session ID, customer id) pair — defence-in-
  // depth ownership constraint baked into the query itself. If a
  // future bug or a crafted payload ever let `vendor_data.customerId`
  // drift away from the row's actual owner, the lookup returns no
  // rows instead of silently handing us a foreign session that the
  // inline `customerId` check further down would still have to
  // catch. The query-level constraint closes the gap even on
  // quick-read paths that skip the inline check for any reason.
  const rows = await ctx.db
    .select()
    .from(kycSessions)
    .where(
      drizzleAnd(
        customerKindFilter,
        eq(kycSessions.diditSessionId, params.diditSessionId),
        eq(kycSessions.customerId, params.customerId),
      ),
    )
    .limit(1);

  // Fallback: look up by the crivacySessionId stored in vendor_data
  // — again scoped to the supplied customer id, so a mismatched
  // vendor_data cannot slip in through the fallback path either.
  let session = rows[0];
  if (session === undefined) {
    const fallbackRows = await ctx.db
      .select()
      .from(kycSessions)
      .where(
        drizzleAnd(
          customerKindFilter,
          eq(kycSessions.id, params.customerSessionId),
          eq(kycSessions.customerId, params.customerId),
        ),
      )
      .limit(1);
    session = fallbackRows[0];
  }

  if (session === undefined) {
    getRootLogger().error(
      {
        event: 'didit_webhook_customer_session_not_found',
        diditSessionId: params.diditSessionId,
        customerSessionId: params.customerSessionId,
        customerId: params.customerId,
      },
      'Customer KYC session not found',
    );
    return ctx.json({ received: true });
  }

  // --- Defence-in-depth ownership check -----------------------------
  //
  // The HMAC gate already establishes that the body came from Didit
  // and that `vendor_data` is what we handed them at session-start.
  // But every downstream side-effect below (ban, notification,
  // credential mint, webhook fan-out) keys off `params.customerId`
  // — the value pulled out of `vendor_data`, not the row we just
  // fetched. A drift between the two shouldn't be possible in a
  // correct system (we set vendor_data ourselves when we created
  // the session), but the gap is exactly the kind of bug that
  // turns into "wrong user was banned" during an incident. Refuse
  // to mutate on mismatch, stamp a loud log for SOC triage, and
  // still 200 so Didit doesn't retry the same inconsistent
  // payload.
  if (session.customerId !== params.customerId) {
    getRootLogger().error(
      {
        event: 'didit_webhook_customer_id_mismatch',
        sessionCustomerId: session.customerId,
        vendorDataCustomerId: params.customerId,
        sessionId: session.id,
        diditSessionId: params.diditSessionId,
      },
      'vendor_data customerId does not match the stored session',
    );
    return ctx.json({ received: true });
  }

  // Map the webhook status to customer session status
  let customerStatus: string;
  if (params.mappedStatus === 'approved') {
    // For identity workflow, the intermediate status is 'identity_approved'
    // For address workflow, the final status is 'approved'
    customerStatus = session.workflow === 'identity' ? 'identity_approved' : 'approved';
  } else {
    customerStatus = params.mappedStatus;
  }

  // -----------------------------------------------------------------
  // Sprint 6 — Face-match cascade evaluation
  // -----------------------------------------------------------------
  //
  // Runs at the terminal-decision boundary (`approved` / `rejected`).
  // The evaluator (`lib/fraud/face-match.ts::evaluateFaceMatch`) is
  // pure; the lookup it consumes is wired via `createFaceMatchLookup`
  // which projects each match's `vendor_data` JSON into the matched
  // account's status (banned / clean / b2b_only / unknown).
  //
  // Branches handled here:
  //   - `cascade_fraud` → demote `customerStatus` to `rejected` with
  //     `failureReason='fraud_cascade'`. The cascade-ban orchestrator
  //     fires AFTER the DB UPDATE (so the freshly-written 'rejected'
  //     row survives `revokeActiveKycSessions`'s active-status filter).
  //   - `block_toast` → demote to `rejected` with
  //     `failureReason='face_match_blocked'`. A `fraud.face_match_blocked`
  //     audit row fires AFTER the DB UPDATE; no cascade ban.
  //   - `reuse` → log INFO and let the normal mint flow continue. The
  //     dedicated rebind / disclose path is a Sprint 6 follow-up;
  //     until it ships, the worst case is a duplicate chain mint
  //     (the worker dedupes on `(firmId, userRef)` but not on face
  //     biometric).
  //   - `no_match` → no override; the legacy fraud classifier below
  //     still runs to catch combined-low-score signals that
  //     `face-match.ts` does not consider.
  let faceMatchEval: FaceMatchEvaluation | null = null;
  let faceMatchOverrideReason: 'fraud_cascade' | 'face_match_blocked' | null = null;
  let hydratedDecisionForCascade: DiditDecisionPayload | null = null;
  if (
    customerStatus === 'identity_approved' ||
    customerStatus === 'approved' ||
    customerStatus === 'rejected'
  ) {
    let faceMatchConfig: DiditConfig | null = null;
    try {
      faceMatchConfig = getDiditConfig();
    } catch {
      // Config unavailable — skip face-match evaluation. The webhook
      // verifier upstream already loaded config successfully, so this
      // path is effectively unreachable in practice; the catch keeps
      // it defensive.
    }
    if (faceMatchConfig !== null) {
      const decision = hydrateDecisionFromWebhookBody(faceMatchConfig, params.webhookBody);
      if (decision !== null) {
        hydratedDecisionForCascade = decision;
        const result = await evaluateFaceMatchFromDecision(ctx.db, decision, {
          kind: 'customer',
          customerId: params.customerId,
        });
        if (result !== null) {
          faceMatchEval = result.evaluation;
          if (result.overrideReason !== null) {
            customerStatus = 'rejected';
            faceMatchOverrideReason = result.overrideReason;
          } else if (result.evaluation.kind === 'reuse') {
            // INFO log lives at call site so each surface stamps its
            // own identifier (the dispatch helper is surface-agnostic).
            getRootLogger().info(
              {
                event: 'didit_webhook_face_match_reuse_pending_impl',
                customerId: params.customerId,
                sessionId: session.id,
                matchedB2bUserRef:
                  result.evaluation.resolvedMatch.status.kind === 'b2b_only'
                    ? result.evaluation.resolvedMatch.status.userRef
                    : null,
              },
              'Sprint 6 reuse branch — rebind path not yet implemented; continuing with normal mint',
            );
          }
        }
      }
    }
  }

  // Resubmission info — Didit's "Resubmitted" payload carries
  // `resubmit_info.nodes_to_resubmit` + `reasons` so the customer UI
  // can render exactly which steps need to be redone. Persist a
  // typed projection on the session row alongside the raw payload.
  let resubmissionInfo: Record<string, unknown> | undefined;
  if (customerStatus === 'resubmission_pending') {
    resubmissionInfo = parseResubmitInfo(params.webhookBody, ctx.now) ?? {
      nodes: [],
      reasons: {},
      requested_at: ctx.now.toISOString(),
    };
  }

  // `kyc_expired` and the success/failure terminals all stamp
  // `completed_at`. `resubmission_pending` and `in_review` are still
  // active — the user (or Didit's compliance UI) has work left.
  const isTerminal =
    customerStatus === 'identity_approved' ||
    customerStatus === 'approved' ||
    customerStatus === 'rejected' ||
    customerStatus === 'kyc_expired';

  // failure_reason precedence (highest first):
  //   1. Sprint 6 face-match override (`fraud_cascade` /
  //      `face_match_blocked`) — beats Didit's text because the human
  //      story is "matched a banned account" / "matched a clean
  //      account", not Didit's generic "Declined".
  //   2. `kyc_expired` — Didit's expiration policy.
  //   3. Hydrated `failureReasonText` from the decline-reason resolver.
  //   4. Legacy fallback `'Declined by Didit'` for rejected sessions.
  let resolvedFailureReason: string | null = null;
  if (faceMatchOverrideReason !== null) {
    resolvedFailureReason = faceMatchOverrideReason;
  } else if (customerStatus === 'kyc_expired') {
    resolvedFailureReason = 'KYC expiration policy triggered by Didit';
  } else if (customerStatus === 'rejected') {
    resolvedFailureReason = 'Declined by Didit';
  }

  await ctx.db
    .update(kycSessions)
    .set({
      status: customerStatus as typeof session.status,
      diditDecisionPayload: params.webhookBody as Record<string, unknown>,
      ...(isTerminal ? { completedAt: ctx.now } : {}),
      ...(resolvedFailureReason !== null ? { failureReason: resolvedFailureReason } : {}),
      ...(resubmissionInfo !== undefined ? { resubmissionInfo } : {}),
      updatedAt: ctx.now,
    })
    .where(drizzleAnd(customerKindFilter, eq(kycSessions.id, session.id)));

  // F-KYC-A2-A-003: kyc_failed audit row for Declined verifications.
  // The credential-pipeline-worker writes `customer.kyc_completed` on
  // approval (`credential-pipeline-worker.ts:903`); the rejection
  // branch needs its symmetric counterpart so the SOC dashboard can
  // surface failed verifications without joining against the session
  // table. `system` actor (Didit-driven) — the customer triggered the
  // attempt but Didit decided the outcome, so attribution lives with
  // the system caller, not the human.
  if (customerStatus === 'rejected') {
    await writeAudit(ctx.db, {
      action: 'customer.kyc_failed',
      actor: systemActor('didit-webhook'),
      target: uuidTarget({ kind: 'customer', id: params.customerId }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        sessionId: session.id,
        diditSessionId: params.diditSessionId,
        workflow: session.workflow,
        rawStatus: params.mappedStatus,
        reason: faceMatchOverrideReason ?? 'Declined by Didit',
      },
      ts: ctx.now,
    });

    // Per-customer decline counter bump. Skip when the cascade-ban
    // path overrode the row to rejected — that already locks the
    // account via `customers.locked_at`; double counting would just
    // delay the cascade-ban audit telemetry. The pull-fallback +
    // reconciler surfaces apply the same skip rule so a single
    // decline event increments at most once across all writers
    // (the partial-unique session UPDATE makes only one writer the
    // winner).
    if (faceMatchOverrideReason === null) {
      await incrementDecline(ctx.db, {
        customerId: params.customerId,
        surface: 'webhook',
        auditContext: buildAuditRequestContext({
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
          requestId: ctx.requestId,
        }),
        kycSessionId: session.id,
        now: ctx.now,
      });
    }
  }

  // Sprint 6 — face-match cascade dispatch. Runs AFTER the DB UPDATE
  // so `revokeActiveKycSessions` (called inside `cascadeBan`) sees
  // the current row at status='rejected' and skips it (its filter is
  // `pending`/`in_progress`/`identity_approved`/`address_in_progress`).
  // Other still-active sessions for the same customer DO get revoked
  // — "force logout from any in-flight Didit attempt".
  if (faceMatchEval !== null && hydratedDecisionForCascade !== null) {
    await applyFaceMatchSideEffects(ctx.db, {
      evaluation: faceMatchEval,
      context: { kind: 'customer', customerId: params.customerId },
      decision: hydratedDecisionForCascade,
      currentDiditSessionId: params.diditSessionId,
      customerKycSessionId: session.id,
      auditContext: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      surface: 'webhook_customer',
      now: ctx.now,
    });
  }

  // In Review audit. Didit's compliance team (or our admin via Resubmission
  // request later) flagged warnings on the verification — the session is
  // parked in a manual queue until human review. Customer-facing UI shows
  // a review banner; the audit row gives SOC observability without joining
  // back to the session table. Symmetric to `customer.kyc_failed` above.
  if (customerStatus === 'in_review') {
    await writeAudit(ctx.db, {
      action: 'customer.kyc_in_review',
      actor: systemActor('didit-webhook'),
      target: uuidTarget({ kind: 'customer', id: params.customerId }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        sessionId: session.id,
        diditSessionId: params.diditSessionId,
        workflow: session.workflow,
        rawStatus: params.mappedStatus,
      },
      ts: ctx.now,
    });
  }

  // Resubmission requested. Didit's compliance ops asked the user to
  // redo specific steps (`resubmit_info.nodes_to_resubmit`); the same
  // session URL resumes from where they left off. Customer-facing UI
  // shows the structured "redo: [liveness, document]" list.
  if (customerStatus === 'resubmission_pending') {
    await writeAudit(ctx.db, {
      action: 'customer.kyc_resubmission_requested',
      actor: systemActor('didit-webhook'),
      target: uuidTarget({ kind: 'customer', id: params.customerId }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        sessionId: session.id,
        diditSessionId: params.diditSessionId,
        workflow: session.workflow,
        rawStatus: params.mappedStatus,
        nodesCount: Array.isArray(resubmissionInfo?.['nodes'])
          ? (resubmissionInfo['nodes'] as unknown[]).length
          : 0,
      },
      ts: ctx.now,
    });
  }

  // KYC expired. Didit's expiration policy fired on a previously-
  // approved session — the credential we minted on Sepolia must come
  // down, the customer's `kyc_level` reverts, and any firm with an
  // active grant gets a `credential.revoked` event. The credential
  // revoke path lives in `lib/fraud/ban.ts::revokeActiveCredentials`
  // — same chain + DB + webhook pipeline used by admin reset and
  // customer ban, exposed as a reusable helper.
  if (customerStatus === 'kyc_expired') {
    try {
      const revokedCount = await revokeActiveCredentials(
        ctx.db,
        params.customerId,
        ctx.now,
        'kyc_expired',
      );
      getRootLogger().info(
        {
          event: 'didit_webhook_kyc_expired_revoke_completed',
          customerId: params.customerId,
          sessionId: session.id,
          revokedCount,
        },
        'KYC expired — credentials revoked',
      );
    } catch (revokeErr) {
      // Best-effort: log + continue. The DB-side row is already
      // flipped to `kyc_expired`; an out-of-band reconciliation can
      // pick up orphaned active credentials. Re-throwing would force
      // Didit into a retry storm against a state that is not idempotent
      // on the chain side.
      getRootLogger().error(
        {
          event: 'didit_webhook_kyc_expired_revoke_failed',
          customerId: params.customerId,
          sessionId: session.id,
          err: revokeErr instanceof Error
            ? { name: revokeErr.name, message: revokeErr.message }
            : String(revokeErr),
        },
        'KYC expired — credential revoke pipeline failed',
      );
    }

    // Reset the customer's kyc_level so the re-verification flow
    // starts clean, then bulk-revoke any non-terminal sessions —
    // pairing the row patch with the session sweep keeps the
    // dashboard from showing a stale "in review" stepper for the
    // expired flow. Both calls go through the canonical helpers in
    // `lib/customer/kyc-reset.ts` so the admin reset_kyc + Didit
    // user-entity revoke + ban paths share one definition.
    const schemaModule = await import('@/lib/db/schema');
    await ctx.db
      .update(schemaModule.customers)
      .set(kycResetCustomerPatch(ctx.now))
      .where(eq(schemaModule.customers.id, params.customerId));
    await revokeActiveKycSessions(
      ctx.db,
      params.customerId,
      ctx.now,
      'kyc_expired',
    );

    await writeAudit(ctx.db, {
      action: 'customer.kyc_expired',
      actor: systemActor('didit-webhook'),
      target: uuidTarget({ kind: 'customer', id: params.customerId }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        sessionId: session.id,
        diditSessionId: params.diditSessionId,
        workflow: session.workflow,
        rawStatus: params.mappedStatus,
      },
      ts: ctx.now,
    });
  }

  // --- Create in-app notification (and email where useful) ---
  //   Approved + Declined: in-app bell only — these are signal-rich
  //                        events firms also receive via webhook;
  //                        downstream credential.created /
  //                        credential.verified / fraud-pipeline emails
  //                        cover the email channel.
  //   Resubmission:        in-app + email — the user must take action
  //                        (redo specific steps); email carries the
  //                        feature labels and the resume URL so the
  //                        action is reachable from the inbox.
  //   KYC Expired:         in-app + email — the credential is gone and
  //                        the user must re-verify; email pushes them
  //                        to /kyc.
  //   In Review:           silent (no row, no email) — the on-page
  //                        banner is enough and a push would just add
  //                        noise to a state where the user can only
  //                        wait.
  const notificationCopy = pickNotificationCopy(customerStatus);
  if (notificationCopy !== null) {
    const KYC_EMAIL_ACTION: Readonly<Record<string, KycStatusAction>> = {
      resubmission_pending: 'resubmission_required',
      kyc_expired: 'kyc_expired',
    };
    const emailAction = KYC_EMAIL_ACTION[customerStatus];
    if (emailAction !== undefined) {
      // notify() handles in-app + email together with preference
      // gating, dispatch logging, and graceful failure (per-channel
      // logging without throwing). For resubmission we also pluck
      // the human-readable feature labels off the parsed
      // resubmit_info so the email body can list "document photo,
      // liveness check, …" instead of generic copy.
      const resubmitInfo =
        emailAction === 'resubmission_required'
          ? parseResubmitInfo(params.webhookBody, ctx.now)
          : null;
      const featureLabels =
        emailAction === 'resubmission_required' && resubmitInfo !== null
          ? extractFeatureLabels(resubmitInfo)
          : undefined;
      const resumeUrl =
        emailAction === 'resubmission_required' &&
        session.verificationUrl !== null &&
        session.verificationUrl !== undefined
          ? session.verificationUrl
          : undefined;
      try {
        await notify(ctx.db, {
          eventType: 'kyc.status_changed',
          recipient: { type: 'customer', customerId: params.customerId },
          inApp: {
            title: notificationCopy.title,
            body: notificationCopy.body,
            link: '/kyc',
          },
          email: {
            emailType: 'notification',
            build: ({ displayName }) =>
              kycStatusChangeEmail({
                displayName,
                action: emailAction,
                ...(featureLabels !== undefined ? { featureLabels } : {}),
                ...(resumeUrl !== undefined ? { resumeUrl } : {}),
              }),
          },
        });
      } catch (notifErr) {
        // Dispatcher swallows per-channel failures; this catch only
        // fires for unexpected throws (e.g. recipient resolution).
        getRootLogger().error(
          {
            event: 'didit_webhook_notification_dispatch_failed',
            customerId: params.customerId,
            sessionId: session.id,
            err:
              notifErr instanceof Error
                ? { name: notifErr.name, message: notifErr.message }
                : String(notifErr),
          },
          'Failed to dispatch KYC status notification (in-app + email)',
        );
      }
    } else {
      // In-app-only branch (Approved / Declined / identity_approved).
      try {
        await createNotification(ctx.db, {
          customerId: params.customerId,
          type: 'kyc.status_changed',
          title: notificationCopy.title,
          body: notificationCopy.body,
          link: '/kyc',
        });
      } catch (notifErr) {
        getRootLogger().error(
          {
            event: 'didit_webhook_notification_create_failed',
            customerId: params.customerId,
            sessionId: session.id,
            err:
              notifErr instanceof Error
                ? { name: notifErr.name, message: notifErr.message }
                : String(notifErr),
          },
          'Failed to create KYC status notification',
        );
      }
    }
  }

  // --- Customer-flow webhook dispatch: kyc.session.* ---
  // `identity_approved` and `address_in_progress` are deliberately
  // NOT emitted — they are intermediate states where basic-level
  // users stop and higher levels proceed to the address workflow.
  // For basic users the downstream `credential.created` /
  // `credential.verified` events (fired by the credential pipeline
  // worker) are the authoritative "they are verified" signal.
  // `kyc.session.approved` here means every workflow the user owns
  // has terminated successfully.
  //
  // The non-default lifecycle events (in_review / resubmission /
  // kyc_expired) are emitted alongside the existing in-app
  // notification + UI banner so firms subscribed to the webhook can
  // surface the same state on their side without polling.
  // `kyc.session.kyc_expired` is paired with `credential.revoked`
  // (fired by `revokeActiveCredentials` upstream) — firms can
  // subscribe to either or both depending on whether they key off
  // session lifecycle or credential lifecycle.
  const TERMINAL_DISPATCH_EVENT: Readonly<
    Record<string, import('@crivacy/shared-types').WebhookEventType>
  > = {
    approved: 'kyc.session.approved',
    rejected: 'kyc.session.rejected',
    in_review: 'kyc.session.in_review',
    resubmission_pending: 'kyc.session.resubmission_required',
    kyc_expired: 'kyc.session.kyc_expired',
  };
  const dispatchEventType = TERMINAL_DISPATCH_EVENT[customerStatus];
  if (dispatchEventType !== undefined) {
    try {
      const { emitUserEvent } = await import('@/lib/webhook');
      const selfServiceFirmId = process.env['CRIVACY_SELF_SERVICE_FIRM_ID'] ?? '';
      const basePayload = {
        sessionId: session.id,
        userRef: params.customerId,
        workflow: session.workflow,
      } as const;
      let payload: Record<string, unknown>;
      switch (customerStatus) {
        case 'approved':
          payload = { ...basePayload, approvedAt: ctx.now.toISOString() };
          break;
        case 'rejected':
          payload = {
            ...basePayload,
            rejectedAt: ctx.now.toISOString(),
            reason: 'Declined by Didit',
          };
          break;
        case 'in_review':
          payload = { ...basePayload, inReviewAt: ctx.now.toISOString() };
          break;
        case 'resubmission_pending': {
          const info = parseResubmitInfo(params.webhookBody, ctx.now);
          // `parseResubmitInfo` returns a loose `Record<string, unknown>`
          // because the wire shape is permissive. We narrow the
          // `nodes` field carefully — `nodes_to_resubmit[]` carries
          // `{ node_id, feature }` per the parser; `reasons` is keyed
          // by node_id. Surfacing a `nodesToResubmit[]` array of
          // `{ feature, reason }` to firms keeps the public payload
          // close to what the customer UI banner already shows.
          const rawNodes = info?.['nodes'];
          const reasonsBlob = info?.['reasons'];
          const reasonsMap =
            typeof reasonsBlob === 'object' && reasonsBlob !== null
              ? (reasonsBlob as Record<string, unknown>)
              : null;
          const nodesToResubmit = Array.isArray(rawNodes)
            ? rawNodes
                .map((n) => {
                  if (typeof n !== 'object' || n === null) return null;
                  const nodeObj = n as Record<string, unknown>;
                  const feature = nodeObj['feature'];
                  const nodeId = nodeObj['node_id'];
                  if (typeof feature !== 'string') return null;
                  const reason =
                    reasonsMap !== null && typeof nodeId === 'string'
                      ? typeof reasonsMap[nodeId] === 'string'
                        ? (reasonsMap[nodeId] as string)
                        : null
                      : null;
                  return reason !== null ? { feature, reason } : { feature };
                })
                .filter((n): n is { feature: string; reason?: string } => n !== null)
            : [];
          payload = {
            ...basePayload,
            requestedAt: ctx.now.toISOString(),
            ...(nodesToResubmit.length > 0 ? { nodesToResubmit } : {}),
            ...(session.verificationUrl !== null && session.verificationUrl !== undefined
              ? { resumeUrl: session.verificationUrl }
              : {}),
          };
          break;
        }
        case 'kyc_expired':
          payload = { ...basePayload, expiredAt: ctx.now.toISOString() };
          break;
        default:
          payload = basePayload;
      }
      await emitUserEvent(ctx.db, {
        customerId: params.customerId,
        ownerFirmId: selfServiceFirmId,
        type: dispatchEventType,
        payload,
        sourceSessionId: session.id,
        idempotencyKey: `${dispatchEventType}:${session.id}`,
        now: ctx.now,
      });
    } catch (webhookErr) {
      getRootLogger().error(
        {
          event: 'didit_webhook_customer_dispatch_failed',
          customerId: params.customerId,
          sessionId: session.id,
          err: webhookErr instanceof Error
            ? { name: webhookErr.name, message: webhookErr.message }
            : String(webhookErr),
        },
        'Customer session terminal webhook dispatch failed',
      );
    }
  }

  // --- Fraud classification for customer rejections ---
  //
  // The legacy classifier reads passthrough fields (`tampering_detected`
  // /  `spoofing_detected` / `replay_detected` / `combined_low_scores`)
  // that are NOT covered by the Sprint 6 face-match cascade. We skip
  // it ONLY when the cascade has already fired — otherwise we'd
  // double-ban (the cascade-ban + this banCustomer call would both
  // attempt the status flip + a second blacklist row + a second
  // audit batch). When `faceMatchOverrideReason === 'face_match_blocked'`
  // we still allow the legacy classifier through: block_toast does
  // NOT ban the customer, so legacy-detected fraud signals on the
  // same payload (rare overlap) should still cascade-ban.
  if (
    params.mappedStatus === 'rejected' &&
    faceMatchOverrideReason !== 'fraud_cascade'
  ) {
    try {
      const classification = classifyDecision(params.webhookBody);
      if (classification === 'fraud') {
        const signals = extractFraudSignals(params.webhookBody);
        const reason = pickFraudReason(signals);
        const signalNames = signals.map((s) => s.name);

        getRootLogger().warn(
          {
            event: 'didit_webhook_customer_fraud_detected',
            customerId: params.customerId,
            signals: signalNames,
            reason,
          },
          'Fraud detected for customer — initiating auto-ban',
        );

        await banCustomer(ctx.db, {
          customerId: params.customerId,
          reason,
          source: 'didit_webhook',
          diditSessionId: params.diditSessionId,
          fraudSignals: signalNames,
          notes: `Auto-ban: fraud signals detected [${signalNames.join(', ')}]`,
        });
      }
    } catch (fraudErr) {
      getRootLogger().error(
        {
          event: 'didit_webhook_customer_fraud_ban_failed',
          customerId: params.customerId,
          err: fraudErr instanceof Error
            ? { name: fraudErr.name, message: fraudErr.message }
            : String(fraudErr),
        },
        'Fraud classification/ban failed',
      );
    }
  }

  // --- Enqueue credential pipeline job if approved ---
  //
  // Skip when the Sprint 6 face-match cascade demoted the row to
  // `rejected` (`faceMatchOverrideReason !== null`). Even though
  // Didit said Approved, our policy says no credential — minting
  // would put a banned/blocked face on chain.
  if (params.mappedStatus === 'approved' && faceMatchOverrideReason === null) {
    try {
      const { enqueueCredentialPipeline } = await import(
        '@/server/jobs/credential-pipeline-worker'
      );
      const { createQueueClient } = await import('@/server/jobs/queue');

      const connectionString = process.env['DATABASE_URL'];
      if (connectionString !== undefined && connectionString.length > 0) {
        const boss = await createQueueClient(connectionString);
        try {
          const phase = session.workflow === 'identity' ? 'identity' : 'address';
          await enqueueCredentialPipeline(boss, {
            kycSessionId: session.id,
            customerId: params.customerId,
            diditSessionId: params.diditSessionId,
            phase,
          });
          getRootLogger().info(
            {
              event: 'didit_webhook_credential_pipeline_enqueued',
              customerId: params.customerId,
              sessionId: session.id,
              phase,
            },
            'Credential pipeline job enqueued',
          );
        } finally {
          await boss.stop();
        }
      } else {
        getRootLogger().error(
          { event: 'didit_webhook_db_url_missing' },
          'DATABASE_URL not set, cannot enqueue credential pipeline',
        );
      }
    } catch (err) {
      // Log but do not throw — the webhook must return 200. The credential
      // pipeline can be triggered later via the resume endpoint.
      getRootLogger().error(
        {
          event: 'didit_webhook_credential_pipeline_enqueue_failed',
          customerId: params.customerId,
          sessionId: session.id,
          err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
        },
        'Failed to enqueue credential pipeline job',
      );
    }
  }

  return ctx.json({ received: true });
}

// ---------------------------------------------------------------------------
// Helpers — resubmission + notification copy
// ---------------------------------------------------------------------------

/**
 * Extract the typed `resubmission_info` projection from a Didit
 * "Resubmitted" webhook body. The upstream shape (per V3 docs §27):
 *
 *   { resubmit_info: {
 *       nodes_to_resubmit: [{ node_id, feature }],
 *       reasons: { [node_id]: string }
 *   } }
 *
 * The wire types are loosely-typed (the webhook schema accepts any
 * shape), so we defensively walk + filter. Returns `null` if the
 * payload doesn't carry a recognisable `resubmit_info` block — the
 * caller falls back to an empty list, which renders a generic
 * "redo all steps" message in the UI.
 */
function parseResubmitInfo(
  webhookBody: unknown,
  now: Date,
): Record<string, unknown> | null {
  if (typeof webhookBody !== 'object' || webhookBody === null) return null;
  const root = webhookBody as Record<string, unknown>;
  const info = root['resubmit_info'];
  if (typeof info !== 'object' || info === null) return null;
  const infoObj = info as Record<string, unknown>;

  const rawNodes = infoObj['nodes_to_resubmit'];
  const nodes: Array<{ node_id: string; feature: string }> = [];
  if (Array.isArray(rawNodes)) {
    for (const item of rawNodes) {
      if (typeof item !== 'object' || item === null) continue;
      const itemObj = item as Record<string, unknown>;
      const nodeId = itemObj['node_id'];
      const feature = itemObj['feature'];
      if (typeof nodeId === 'string' && typeof feature === 'string') {
        nodes.push({ node_id: nodeId, feature });
      }
    }
  }

  const rawReasons = infoObj['reasons'];
  const reasons: Record<string, string> = {};
  if (typeof rawReasons === 'object' && rawReasons !== null) {
    for (const [k, v] of Object.entries(rawReasons as Record<string, unknown>)) {
      if (typeof v === 'string') reasons[k] = v;
    }
  }

  return {
    nodes,
    reasons,
    requested_at: now.toISOString(),
  };
}

/**
 * Map a Didit feature node id to the same human-readable label the
 * `/kyc` page banner uses (`OCR` → "document photo", `LIVENESS` →
 * "liveness check", …). Kept in lock-step with the customer UI's
 * `formatFeatureLabel` so an email's "redo: document photo, liveness
 * check" list reads identically to what the user sees on the page.
 */
const FEATURE_LABEL_MAP: Readonly<Record<string, string>> = {
  OCR: 'document photo',
  LIVENESS: 'liveness check',
  FACE_MATCH: 'face match',
  NFC: 'document chip read',
  POA: 'proof of address',
  PHONE: 'phone verification',
  EMAIL: 'email verification',
  AML: 'compliance screening',
  DATABASE_VALIDATION: 'database validation',
  IP_ANALYSIS: 'IP analysis',
  QUESTIONNAIRE: 'questionnaire',
  AGE_ESTIMATION: 'age estimation',
};

function formatFeatureLabel(feature: string): string {
  if (feature in FEATURE_LABEL_MAP) return FEATURE_LABEL_MAP[feature]!;
  return feature
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Pluck the human-friendly feature labels (`document photo`, `liveness
 * check`, …) off the parsed `resubmit_info` block. Returns `undefined`
 * when the payload carries no recognisable nodes — the caller's email
 * template then falls back to a generic "redo all flagged steps"
 * copy.
 */
function extractFeatureLabels(
  resubmitInfo: Record<string, unknown>,
): readonly string[] | undefined {
  const rawNodes = resubmitInfo['nodes'];
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) return undefined;
  const labels = rawNodes
    .map((n) => {
      if (typeof n !== 'object' || n === null) return null;
      const feature = (n as Record<string, unknown>)['feature'];
      return typeof feature === 'string' ? formatFeatureLabel(feature) : null;
    })
    .filter((label): label is string => label !== null);
  return labels.length > 0 ? labels : undefined;
}

interface NotificationCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * Map a customer-flow status to its in-app notification copy. Returns
 * `null` for states that intentionally do not push a notification
 * (e.g. `in_review` — the on-page banner is sufficient and a push
 * would just add noise to a state that requires no user action).
 */
function pickNotificationCopy(customerStatus: string): NotificationCopy | null {
  switch (customerStatus) {
    case 'identity_approved':
    case 'approved':
      return {
        title: 'KYC Status Updated',
        body: 'Your identity verification status is now approved.',
      };
    case 'rejected':
      return {
        title: 'KYC Status Updated',
        body: 'Your identity verification status is now declined.',
      };
    case 'resubmission_pending':
      return {
        title: 'Verification needs additional steps',
        body: 'Some steps in your verification need to be redone. Open Verification to continue.',
      };
    case 'kyc_expired':
      return {
        title: 'Your KYC has expired',
        body: 'Your verified identity has expired. Re-verify to continue using verified services.',
      };
    default:
      return null;
  }
}
