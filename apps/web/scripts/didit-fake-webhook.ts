/**
 * Didit fake webhook injector — dev-only tool.
 *
 * Crafts a Didit V3 webhook payload, signs it with the project's
 * `DIDIT_WEBHOOK_SECRET`, and POSTs it to the local handler at
 * `http://localhost:3001/api/webhooks/didit`. This lets us drive the
 * webhook handler through every documented status transition without
 * an active Didit account or a paid session — both of which we don't
 * have at dev time.
 *
 * Usage:
 *   pnpm dlx dotenv-cli -e .env -- pnpm tsx scripts/didit-fake-webhook.ts \
 *     --status="In Review" \
 *     --customer-session-id=<uuid> \
 *     --didit-session-id=<uuid> \
 *     --customer-id=<uuid>
 *
 *   # Optional flags:
 *   --workflow=identity|address     (default: identity → kyc workflow id)
 *   --base-url=http://localhost:3001 (default)
 *
 * Status values per Didit V3 docs (case-sensitive, exact strings):
 *   "Not Started" | "In Progress" | "Approved" | "Declined" |
 *   "In Review"   | "Resubmitted" | "Expired"  | "Abandoned" |
 *   "Kyc Expired"
 *
 * Vendor-data shape (customer flow):
 *   { type: "customer", crivacySessionId: <uuid>, customerId: <uuid> }
 *
 * SECURITY NOTE: This script reads the production webhook secret from
 * env. It must NEVER be invoked against a non-dev environment. It is
 * the dev-side counterpart to a Didit dashboard "send test webhook"
 * button — useful for exercising the handler when the upstream
 * service is not available.
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { canonicalJson } from '@crivacy-fhe/adapter-didit/canonical';
import { isDiditUserEntityWebhookType } from '@crivacy-fhe/adapter-didit/types';

interface CliArgs {
  status: string;
  customerSessionId: string;
  diditSessionId: string;
  customerId: string;
  workflow: 'identity' | 'address';
  baseUrl: string;
  decorationFile: string | null;
  /**
   * `status.updated` (default — session-level event) or
   * `user.data.updated` / `user.status.updated` for user-entity
   * events (Batch E). For user.* events, `--status` is reused as
   * the user-entity status (`BLOCKED`, `FLAGGED`, `ACTIVE`); for
   * deletion, pass `--user-deleted` and the script sets
   * `deleted_at` automatically.
   */
  webhookType: string;
  vendorUserId: string | null;
  userDeleted: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const map = new Map<string, string>();
  // Boolean flags (no `=value` payload).
  const booleanFlags = new Set<string>();
  for (const arg of args) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m === null) {
      // Tolerate boolean-style flags like `--user-deleted`.
      const bm = /^--([^=]+)$/.exec(arg);
      if (bm !== null) {
        booleanFlags.add(bm[1]!);
        continue;
      }
      throw new Error(`Bad arg: ${arg}. Use --key=value or --flag form.`);
    }
    map.set(m[1]!, m[2]!);
  }

  const webhookType = map.get('webhook-type') ?? 'status.updated';
  const userDeleted = booleanFlags.has('user-deleted');
  const isUserEvent = isDiditUserEntityWebhookType(webhookType);

  const customerId = map.get('customer-id');
  if (customerId === undefined) {
    throw new Error('Required: --customer-id');
  }

  // Session-level events need session ids; user-level events do not.
  const customerSessionId = map.get('customer-session-id') ?? '';
  const diditSessionId = map.get('didit-session-id') ?? '';
  const status = map.get('status') ?? (isUserEvent ? 'ACTIVE' : '');

  if (!isUserEvent) {
    if (
      status === '' ||
      customerSessionId === '' ||
      diditSessionId === ''
    ) {
      throw new Error(
        'Session-level events require: --status, --customer-session-id, --didit-session-id',
      );
    }
  }

  const rawWorkflow = map.get('workflow') ?? 'identity';
  if (rawWorkflow !== 'identity' && rawWorkflow !== 'address') {
    throw new Error('--workflow must be "identity" or "address"');
  }

  return {
    status,
    customerSessionId,
    diditSessionId,
    customerId,
    workflow: rawWorkflow,
    baseUrl: map.get('base-url') ?? 'http://localhost:3001',
    decorationFile: map.get('decoration-file') ?? null,
    webhookType,
    vendorUserId: map.get('vendor-user-id') ?? null,
    userDeleted,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  const secret = process.env['DIDIT_WEBHOOK_SECRET'];
  if (secret === undefined || secret.length === 0) {
    throw new Error('DIDIT_WEBHOOK_SECRET is required (load from .env via dotenv-cli)');
  }

  const workflowId =
    args.workflow === 'identity'
      ? process.env['DIDIT_KYC_WORKFLOW_ID']
      : process.env['DIDIT_ADDRESS_WORKFLOW_ID'];
  if (workflowId === undefined || workflowId.length === 0) {
    throw new Error(
      `DIDIT_${args.workflow === 'identity' ? 'KYC' : 'ADDRESS'}_WORKFLOW_ID is required`,
    );
  }

  const nowMs = Date.now();
  const decoration: Record<string, unknown> =
    args.decorationFile !== null
      ? (JSON.parse(readFileSync(args.decorationFile, 'utf8')) as Record<string, unknown>)
      : {};

  const isUserEvent = isDiditUserEntityWebhookType(args.webhookType);

  const vendorDataString = JSON.stringify({
    type: 'customer',
    crivacySessionId: args.customerSessionId,
    customerId: args.customerId,
  });

  let body: Record<string, unknown>;
  if (isUserEvent) {
    // User-entity event shape (Batch E): no session_id / workflow_id;
    // carries vendor_user_id (Didit's stable internal user UUID) +
    // event-specific fields (status/previous_status/reason for
    // status.updated; changed_fields/changes/deleted_at for
    // data.updated).
    const vendorUserId = args.vendorUserId ?? `00000000-0000-4000-8000-${'0'.repeat(12)}`;
    const baseUserBody: Record<string, unknown> = {
      webhook_type: args.webhookType,
      vendor_user_id: vendorUserId,
      vendor_data: vendorDataString,
      timestamp: new Date(nowMs).toISOString(),
      event_id: `evt_${nowMs.toString(36)}`,
    };
    if (args.userDeleted) {
      // Mirror the documented `users_delete.md:32` shape: emits
      // user.data.updated with deleted_at set. We populate both
      // top-level `deleted_at` AND `changes.current.deleted_at` so
      // the handler's defensive read sees the signal regardless of
      // which path Didit ships in production.
      const deletedAt = new Date(nowMs).toISOString();
      Object.assign(baseUserBody, {
        webhook_type: 'user.data.updated',
        deleted_at: deletedAt,
        changed_fields: ['deleted_at'],
        changes: {
          previous: { deleted_at: null },
          current: { deleted_at: deletedAt },
        },
      });
    } else if (args.webhookType === 'user.status.updated') {
      Object.assign(baseUserBody, {
        previous_status: 'ACTIVE',
        status: args.status,
        reason: 'fake-webhook test trigger',
      });
    } else {
      // user.data.updated without --user-deleted → noop change
      // (display_name) for the audit-only path.
      Object.assign(baseUserBody, {
        changed_fields: ['display_name'],
        changes: {
          previous: { display_name: 'Test User' },
          current: { display_name: 'Test User Updated' },
        },
      });
    }
    body = { ...baseUserBody, ...decoration };
  } else {
    body = {
      session_id: args.diditSessionId,
      workflow_id: workflowId,
      vendor_data: vendorDataString,
      status: args.status,
      timestamp: new Date(nowMs).toISOString(),
      webhook_type: args.webhookType,
      ...decoration,
    };
  }

  const canonical = canonicalJson(body);
  const signatureV2 = createHmac('sha256', secret).update(canonical).digest('hex');
  const timestampSeconds = String(Math.floor(nowMs / 1000));

  const url = `${args.baseUrl}/api/webhooks/didit`;
  // eslint-disable-next-line no-console
  console.log(`[didit-fake-webhook] POST ${url}`);
  // eslint-disable-next-line no-console
  console.log(
    `[didit-fake-webhook] type=${args.webhookType} status=${args.status} ${
      isUserEvent ? `customer=${args.customerId}` : `session=${args.customerSessionId}`
    }`,
  );

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-timestamp': timestampSeconds,
      'x-signature-v2': signatureV2,
    },
    body: canonical,
  });

  const text = await res.text();
  // eslint-disable-next-line no-console
  console.log(`[didit-fake-webhook] HTTP ${res.status} ${text}`);

  if (!res.ok) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
