/**
 * Didit webhook test harness — shared across status-mapping tests.
 *
 * The 3 status-mapping test files (`didit-status-mapping`,
 * `didit-resubmitted-kyc-expired`, `didit-unknown-status`) all need to
 * craft a verified `WebhookInput` (HMAC-signed body + matching
 * timestamp header) and a stub `WebhookContext` whose `db` returns a
 * single session row. Earlier each file inlined the helpers; the
 * builders drifted apart over time and any future Didit envelope shape
 * change had to be patched in 3+ places. This harness pins both
 * helpers in one location so a Didit wire-format change is a
 * single-file edit.
 *
 * The harness is intentionally minimal — it does NOT mock
 * `@/lib/audit/writer`, `@/lib/notification`, `@/lib/notification/dispatcher`,
 * `@/lib/fraud`, or `@/lib/webhook`. Those mocks are call-site
 * concerns (some tests want the real implementation, some want
 * specific mock returns) and live in the individual test files.
 *
 * @module
 */

import { NextResponse } from 'next/server';
import { createHmac } from 'node:crypto';
import { vi } from 'vitest';

import { canonicalJson } from '@crivacy-fhe/adapter-didit/canonical';
import type { DiditUserEntityWebhookType } from '@crivacy-fhe/adapter-didit/types';
import type { handleDiditWebhook } from '@/server/handlers/didit-webhook';

/* ---------- Webhook input builder ---------- */

export interface BuildVerifiedInputOpts {
  /** Webhook secret used to sign the canonical body. */
  readonly webhookSecret: string;
  /** Didit `status` field value (`Approved`, `In Review`, …). */
  readonly status: string;
  /** Vendor data — string passes through, object is JSON-stringified. */
  readonly vendorData: unknown;
  /** Crivacy session UUID embedded in `session_id` (not vendor data). */
  readonly diditSessionId: string;
  /** Workflow id Didit returns. Production fixtures use a stable UUID. */
  readonly diditWorkflowId?: string;
  /** Wall-clock time used for `timestamp` header + body field. */
  readonly now: Date;
  /** Optional payload extensions (resubmit_info, etc). */
  readonly decoration?: Record<string, unknown>;
}

export interface VerifiedWebhookInput {
  readonly rawBody: string;
  readonly body: Record<string, unknown>;
  readonly headers: { readonly 'x-timestamp': string; readonly 'x-signature-v2': string };
}

/**
 * Build a `WebhookInput` shape that the production route layer would
 * forward to `handleDiditWebhook`: canonical-JSON body + matching V2
 * HMAC signature header + current-second timestamp header. Mirrors
 * the route layer 1-for-1 so the handler exercises the same code path
 * as production.
 */
export function buildVerifiedDiditInput(opts: BuildVerifiedInputOpts): VerifiedWebhookInput {
  const body: Record<string, unknown> = {
    session_id: opts.diditSessionId,
    workflow_id: opts.diditWorkflowId ?? '11111111-2222-4333-8444-555555555555',
    vendor_data:
      typeof opts.vendorData === 'string' ? opts.vendorData : JSON.stringify(opts.vendorData),
    status: opts.status,
    timestamp: opts.now.toISOString(),
    webhook_type: 'status.updated',
    ...(opts.decoration ?? {}),
  };
  const timestampSeconds = Math.floor(opts.now.getTime() / 1000);
  const canonical = canonicalJson(body);
  const signatureV2 = createHmac('sha256', opts.webhookSecret).update(canonical).digest('hex');
  return {
    rawBody: canonical,
    body,
    headers: {
      'x-timestamp': String(timestampSeconds),
      'x-signature-v2': signatureV2,
    },
  };
}

/* ---------- User-entity webhook input builder (Batch E) ---------- */

export interface BuildUserEntityInputOpts {
  /** Webhook secret used to sign the canonical body. */
  readonly webhookSecret: string;
  /** `user.data.updated` or `user.status.updated`. */
  readonly webhookType: DiditUserEntityWebhookType;
  /** Vendor data — string passes through, object is JSON-stringified. */
  readonly vendorData: unknown;
  /** Didit's stable internal user UUID (required for user.* events). */
  readonly vendorUserId: string;
  /** Wall-clock time used for `timestamp` header + body field. */
  readonly now: Date;
  /**
   * Body extensions: top-level `deleted_at`, `changed_fields`, `changes`,
   * `status`, `previous_status`, `reason`, etc. The harness does not
   * try to model the full discriminated union — callers craft the
   * shape that matches the documented Didit V3 wire format.
   */
  readonly decoration?: Record<string, unknown>;
}

/**
 * Build a verified user-entity webhook input. Mirror of
 * `buildVerifiedDiditInput` but for the `user.*` event family — no
 * `session_id` / `workflow_id`; carries `vendor_user_id` instead.
 *
 * Reference for body shape:
 *   - api-references/management-api_users_update-status.md:33
 *   - api-references/management-api_users_update.md:30
 *   - api-references/management-api_users_delete.md:32
 *
 * Live docs (https://docs.didit.me/integration/webhooks) confirm the
 * field listings; the documented examples are session-level only, so
 * this fixture composes the field listings from prose docs +
 * transaction-event envelope precedent.
 */
export function buildUserEntityWebhookInput(
  opts: BuildUserEntityInputOpts,
): VerifiedWebhookInput {
  const body: Record<string, unknown> = {
    vendor_user_id: opts.vendorUserId,
    vendor_data:
      typeof opts.vendorData === 'string' ? opts.vendorData : JSON.stringify(opts.vendorData),
    timestamp: opts.now.toISOString(),
    webhook_type: opts.webhookType,
    ...(opts.decoration ?? {}),
  };
  const timestampSeconds = Math.floor(opts.now.getTime() / 1000);
  const canonical = canonicalJson(body);
  const signatureV2 = createHmac('sha256', opts.webhookSecret).update(canonical).digest('hex');
  return {
    rawBody: canonical,
    body,
    headers: {
      'x-timestamp': String(timestampSeconds),
      'x-signature-v2': signatureV2,
    },
  };
}

/* ---------- User-entity ctx builder (Batch E) ---------- */

export interface MockCustomerRow {
  readonly id: string;
  readonly kycLevel: string;
}

export interface UserEntityCtxBundle {
  readonly ctx: Parameters<typeof handleDiditWebhook>[0];
  readonly customersUpdates: Array<Record<string, unknown>>;
  readonly sessionsUpdates: Array<Record<string, unknown>>;
  readonly customerSelects: number;
}

/**
 * Stub DB context for `handleUserEntityWebhook` tests. The handler
 * issues:
 *
 *   1. SELECT id, kyc_level FROM customers WHERE id = ? LIMIT 1
 *   2. UPDATE customers SET ... WHERE id = ?
 *   3. UPDATE customer_kyc_sessions SET status='revoked' WHERE customerId=? AND status IN (...)
 *
 * The stub returns the supplied `customerRow` for #1 (or null when
 * `customerRow === null` to simulate an orphan), and records each
 * `set(...)` payload from #2 + #3 separately.
 *
 * Both UPDATE chains share `update().set().where()` shape; the stub
 * tells them apart by which `update()` call returns the chain. A
 * `whichTable` counter steps through `customers` → `customer_kyc_sessions`
 * in call order.
 */
export function buildUserEntityCtx(
  customerRow: MockCustomerRow | null,
  opts: { readonly now: Date; readonly requestId?: string },
): UserEntityCtxBundle {
  const customersUpdates: Array<Record<string, unknown>> = [];
  const sessionsUpdates: Array<Record<string, unknown>> = [];
  let updateCallIndex = 0;
  const updateSpy = vi.fn(() => {
    const i = updateCallIndex;
    updateCallIndex += 1;
    return {
      set: (patch: Record<string, unknown>) => {
        if (i === 0) {
          customersUpdates.push(patch);
        } else {
          sessionsUpdates.push(patch);
        }
        // Sessions update goes through the `revokeActiveKycSessions`
        // helper which chains `.returning({ id })`; keep both shapes
        // by making `.where()` itself thenable AND attaching a
        // synchronous `.returning()` that resolves to an empty list
        // (the test only asserts the patch shape, not the count).
        const wherePromise: Promise<undefined> & {
          readonly returning: () => Promise<readonly { id: string }[]>;
        } = Object.assign(Promise.resolve(undefined as undefined), {
          returning: async () => [] as readonly { id: string }[],
        });
        return { where: () => wherePromise };
      },
    };
  });
  let customerSelectCount = 0;
  const selectSpy = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          customerSelectCount += 1;
          return customerRow !== null ? [customerRow] : [];
        },
      }),
    }),
  }));
  const ctx = {
    db: { select: selectSpy, update: updateSpy },
    now: opts.now,
    requestId: opts.requestId ?? 'e2222222-2222-4222-8222-222222222222',
    ip: '203.0.113.5',
    userAgent: 'didit/fixture',
    json: (payload: unknown) => NextResponse.json(payload, { status: 200 }),
    errorJson: (code: string, message: string, status: number) =>
      NextResponse.json({ error: { code, message } }, { status }),
  } as unknown as Parameters<typeof handleDiditWebhook>[0];
  return {
    ctx,
    customersUpdates,
    sessionsUpdates,
    get customerSelects() {
      return customerSelectCount;
    },
  };
}

/* ---------- Webhook context builder ---------- */

export interface MockSessionRow {
  readonly id: string;
  readonly customerId: string;
  readonly diditSessionId: string | null;
  readonly workflow: 'identity' | 'address';
  readonly status: string;
  /** Optional verification URL used by the Resubmitted resume flow. */
  readonly verificationUrl?: string | null;
}

export interface CustomerCtxBundle {
  readonly ctx: Parameters<typeof handleDiditWebhook>[0];
  readonly updateSpy: ReturnType<typeof vi.fn>;
  /**
   * Each `update().set(patch)` call appends to this list so tests
   * can inspect the exact UPDATE payload the handler sent.
   */
  readonly setCalls: Array<Record<string, unknown>>;
}

/**
 * Build a stubbed customer-flow `WebhookContext` whose DB returns a
 * single session row on `select` and captures `update.set(...)` calls
 * in a list. Reused across the 3 status-mapping test files.
 */
export function buildCustomerWebhookCtx(
  sessionRow: MockSessionRow,
  opts: { readonly now: Date; readonly requestId?: string },
): CustomerCtxBundle {
  const setCalls: Array<Record<string, unknown>> = [];
  const updateSpy = vi.fn(() => ({
    set: (patch: Record<string, unknown>) => {
      setCalls.push(patch);
      // Some callers chain `.returning({ id })` after `.where()` (the
      // canonical `revokeActiveKycSessions` helper does). Make the
      // result thenable AND attach a `.returning()` that resolves to
      // an empty list so both shapes work without forcing the caller
      // to await.
      const wherePromise: Promise<undefined> & {
        readonly returning: () => Promise<readonly { id: string }[]>;
      } = Object.assign(Promise.resolve(undefined as undefined), {
        returning: async () => [] as readonly { id: string }[],
      });
      return { where: () => wherePromise };
    },
  }));
  const selectSpy = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => [sessionRow],
      }),
    }),
  }));
  const ctx = {
    db: { select: selectSpy, update: updateSpy },
    now: opts.now,
    requestId: opts.requestId ?? 'e1111111-1111-4111-8111-111111111111',
    ip: '203.0.113.5',
    userAgent: 'didit/fixture',
    json: (payload: unknown) => NextResponse.json(payload, { status: 200 }),
    errorJson: (code: string, message: string, status: number) =>
      NextResponse.json({ error: { code, message } }, { status }),
  } as unknown as Parameters<typeof handleDiditWebhook>[0];
  return { ctx, updateSpy, setCalls };
}
