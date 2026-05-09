/**
 * Ban orchestrator — coordinates all side effects of banning a
 * customer for fraud.
 *
 * When a customer is banned (either automatically by the Didit
 * webhook fraud classifier or manually by an admin), the following
 * steps must happen atomically:
 *
 *   1. Set `customers.status = 'banned'`
 *   2. Compute the email hash and add to the blacklist
 *   3. Revoke all active B2B credentials on Sepolia and in the DB
 *   4. Revoke all active customer KYC sessions
 *   5. Revoke all active customer auth sessions
 *   6. Write audit entries for every action taken
 *
 * The caller (webhook handler or admin route) is responsible for
 * sending notification emails separately — this module does not
 * enqueue email jobs to keep the ban operation synchronous and
 * auditable.
 *
 * @module
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import { getRootLogger } from '@/lib/observability/logger';
import { writeAudit, writeAuditBatch } from '@/lib/audit/writer';
import type { WriteAuditInput } from '@/lib/audit/writer';
import { systemActor, adminUserActor } from '@/lib/audit/actors';
import type { AuditActor } from '@/lib/audit/actors';
import { uuidTarget } from '@/lib/audit/targets';
import { EMPTY_CONTEXT } from '@/lib/audit/context';
import type { AuditRequestContext } from '@/lib/audit/context';
import { getFheClient } from '@crivacy-fhe/credential';

import { revokeActiveKycSessions as revokeActiveCustomerKycSessions } from '@/lib/customer/kyc-reset';

import { hashEmail, addToBlacklist } from './blacklist';
import type { FraudReason } from './types';

/* ---------- Types ---------- */

export interface BanCustomerInput {
  readonly customerId: string;
  readonly reason: FraudReason;
  /** Origin: `'didit_webhook'` for auto-ban, `'admin_manual'` for human ban. */
  readonly source: string;
  readonly diditSessionId?: string | undefined;
  /**
   * SHA-256 of the matched Didit session id (Sprint 6). Persisted on
   * the blacklist row written below so the pre-Didit start-session
   * gate can refuse re-attempts with the same face without paying
   * the Didit face_search cost.
   */
  readonly faceHash?: string | undefined;
  /** UUID of the admin who initiated the ban (null for automatic bans). */
  readonly bannedBy?: string | undefined;
  /** Free-text audit notes. */
  readonly notes?: string | undefined;
  /** Fraud signal names for the audit meta. */
  readonly fraudSignals?: readonly string[] | undefined;
  /** Audit request context from the originating request. */
  readonly auditContext?: AuditRequestContext | undefined;
}

export interface BanResult {
  readonly blacklistId: string;
  readonly credentialsRevoked: number;
  readonly sessionsRevoked: number;
  readonly kycSessionsRevoked: number;
}

/* ---------- Public API ---------- */

/**
 * Ban a customer: set status, blacklist, revoke credentials, revoke
 * sessions, and write a comprehensive audit trail.
 *
 * This function is idempotent on the status transition — if the
 * customer is already banned, it will still add a blacklist entry
 * (in case a previous ban missed the blacklist step) and revoke
 * any remaining active credentials/sessions.
 *
 * Throws if the customer ID does not exist.
 */
export async function banCustomer(
  db: CrivacyDatabase,
  input: BanCustomerInput,
): Promise<BanResult> {
  const now = new Date();
  const auditContext = input.auditContext ?? EMPTY_CONTEXT;

  // Determine the audit actor — admin for manual bans, system for auto-bans
  const actor: AuditActor = input.bannedBy !== undefined
    ? adminUserActor({ id: input.bannedBy, label: `admin:${input.bannedBy}` })
    : systemActor('didit-fraud-classifier');

  const customerTarget = uuidTarget({ kind: 'customer', id: input.customerId });

  // --- 1. Fetch customer and validate existence ---
  const customerRows = await db
    .select({ id: schema.customers.id, email: schema.customers.email, status: schema.customers.status })
    .from(schema.customers)
    .where(and(eq(schema.customers.id, input.customerId), isNull(schema.customers.deletedAt)))
    .limit(1);

  const customer = customerRows[0];
  if (customer === undefined) {
    throw new Error(`banCustomer: customer not found: ${input.customerId}`);
  }

  const previousStatus = customer.status;

  // --- 2. Set customer status to banned ---
  await db
    .update(schema.customers)
    .set({
      status: 'banned',
      updatedAt: now,
    })
    .where(eq(schema.customers.id, input.customerId));

  // --- 3. Compute email hash (if email exists) and add to blacklist ---
  const emailHash = customer.email !== null ? hashEmail(customer.email) : null;
  const blacklistEntry = await addToBlacklist(db, {
    emailHash,
    reason: input.reason,
    source: input.source,
    diditSessionId: input.diditSessionId,
    faceHash: input.faceHash,
    customerId: input.customerId,
    bannedBy: input.bannedBy,
    notes: input.notes,
  });

  // --- 4. Revoke all active B2B credentials (chain + DB) ---
  const credentialsRevoked = await revokeActiveCredentials(db, input.customerId, now);

  // --- 5. Revoke all active customer KYC sessions ---
  const kycSessionsRevoked = await revokeActiveCustomerKycSessions(
    db,
    input.customerId,
    now,
    'customer_banned',
  );

  // --- 6. Revoke all active customer auth sessions ---
  const sessionsRevoked = await revokeActiveCustomerSessions(db, input.customerId, now);

  // --- 7. Write audit trail ---
  const auditEntries: WriteAuditInput[] = [
    {
      action: 'customer.fraud_detected',
      actor,
      target: customerTarget,
      context: auditContext,
      meta: {
        reason: input.reason,
        source: input.source,
        ...(input.fraudSignals !== undefined && input.fraudSignals.length > 0
          ? { fraudSignals: input.fraudSignals }
          : {}),
        ...(input.diditSessionId !== undefined
          ? { diditSessionId: input.diditSessionId }
          : {}),
      },
      ts: now,
    },
    {
      action: 'customer.banned',
      actor,
      target: customerTarget,
      context: auditContext,
      meta: {
        previousStatus,
        reason: input.reason,
        credentialsRevoked,
        sessionsRevoked,
        kycSessionsRevoked,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      ts: now,
    },
    {
      action: 'blacklist.added',
      actor,
      target: customerTarget,
      context: auditContext,
      meta: {
        blacklistId: blacklistEntry.id,
        reason: input.reason,
        source: input.source,
      },
      ts: now,
    },
  ];

  await writeAuditBatch(db, auditEntries);

  return {
    blacklistId: blacklistEntry.id,
    credentialsRevoked,
    sessionsRevoked,
    kycSessionsRevoked,
  };
}

/* ---------- Credential revocation (shared) ---------- */

/**
 * Revoke all active credentials (status = 'pending' or 'active')
 * linked to a customer. For each credential:
 *
 *   1. Revoke the on-chain chain contract (best-effort)
 *   2. Set DB status to 'revoked' with the given reason
 *   3. Dispatch `credential.revoked` webhook to the credential's firm
 *
 * The B2B `kycCredentialsMeta` table is keyed by `(firmId, userRef)`.
 * Customer credentials use the customer ID as the `userRef`. We find
 * all active credentials where `userRef = customerId` regardless of
 * which firm issued them.
 *
 * Exported so `admin-customers.ts` (reset_kyc) can reuse the same
 * chain + DB + webhook pipeline without duplicating logic.
 *
 * Returns the number of credentials revoked in the DB.
 */
export async function revokeActiveCredentials(
  db: CrivacyDatabase,
  customerId: string,
  now: Date,
  reason: string = 'customer_banned',
): Promise<number> {
  // Find all active credentials where userRef matches the customer ID.
  // Pull the full row (rather than a slim subset) so the `credential.revoked`
  // webhook payload below can be derived from the canonical view —
  // `lib/credentials/view.ts` is the single source of truth for what
  // a credential snapshot looks like on the wire.
  const activeCredentials = await db
    .select()
    .from(schema.kycCredentialsMeta)
    .where(
      and(
        eq(schema.kycCredentialsMeta.userRef, customerId),
        inArray(schema.kycCredentialsMeta.status, ['pending', 'active']),
      ),
    );

  if (activeCredentials.length === 0) {
    return 0;
  }

  // Attempt on-chain revocation for each credential that landed on chain.
  let fhe: ReturnType<typeof getFheClient> | null = null;
  try {
    fhe = getFheClient();
  } catch {
    // FHE not configured — skip on-chain revocation (e.g. in tests)
    getRootLogger().warn(
      { event: 'credential_revoke_fhe_unavailable' },
      'FHE client not available; skipping on-chain revocation',
    );
  }

  for (const credential of activeCredentials) {
    // 1. Revoke on-chain if the credential was minted (has a tx recorded).
    if (fhe !== null && credential.chainContractId !== null) {
      // Cascade-burn the bound soulbound NFT in the same call when present
      // (Basic-level rows have nftContractId = null and skip the burn). The
      // credential is keyed on the subject's EVM address (`userParty`).
      const burnNft = credential.nftContractId !== null;
      try {
        await fhe.revokeCredential(credential.userParty as `0x${string}`, burnNft);
      } catch (err) {
        // Log but do not abort — the DB-side revocation still proceeds.
        // A reconciliation job can clean up orphaned on-chain records.
        getRootLogger().error(
          {
            event: 'credential_revoke_fhe_failed',
            userParty: credential.userParty,
            err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
          },
          'On-chain credential revocation failed; DB-side revocation continues',
        );
      }
    }

    // 2. Revoke in DB
    await db
      .update(schema.kycCredentialsMeta)
      .set({
        status: 'revoked',
        revokedAt: now,
        revokedReason: reason,
        // Mirror the on-chain cascade burn into the DB row when the
        // credential carried an NFT.
        ...(credential.nftContractId !== null ? { nftBurnedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(schema.kycCredentialsMeta.id, credential.id));

    // 3. Dispatch credential.revoked webhook. Fan-out reaches every
    //    firm the user has a live relationship with (OAuth consent
    //    or B2B credential), not only the credential's creator firm.
    //    Payload is the canonical credential view (with status +
    //    revokedAt + revokedReason patched to reflect the just-
    //    written DB UPDATE) plus the revoke-specific `reason` extra.
    try {
      const { emitUserEvent } = await import('@/lib/webhook');
      const { fromKycCredentialMetaRow, toWebhookPayload } = await import(
        '@/lib/credentials/view'
      );
      const revokedView = {
        ...fromKycCredentialMetaRow(credential),
        status: 'revoked' as const,
        revokedAt: now,
        revokedReason: reason,
      };
      await emitUserEvent(db, {
        customerId,
        ownerFirmId: credential.firmId,
        type: 'credential.revoked',
        payload: { ...toWebhookPayload(revokedView), reason },
        sourceCredentialId: credential.id,
        idempotencyKey: `revoke:${credential.id}:${reason}`,
        now,
      });
    } catch (webhookErr) {
      // Webhook dispatch failure is non-critical — the revocation already
      // succeeded on Sepolia and DB. Log and continue.
      getRootLogger().error(
        {
          event: 'credential_revoke_webhook_failed',
          credentialId: credential.id,
          err: webhookErr instanceof Error
            ? { name: webhookErr.name, message: webhookErr.message }
            : String(webhookErr),
        },
        'webhook dispatch failed after credential revocation',
      );
    }
  }

  return activeCredentials.length;
}

/**
 * Revoke all active customer auth sessions. Sets `revoked_at` and
 * `revoked_reason` so the JWT verification middleware will reject
 * any further requests from this customer.
 */
async function revokeActiveCustomerSessions(
  db: CrivacyDatabase,
  customerId: string,
  now: Date,
): Promise<number> {
  const result = await db
    .update(schema.customerSessions)
    .set({
      revokedAt: now,
      revokedReason: 'customer_banned',
    })
    .where(
      and(
        eq(schema.customerSessions.customerId, customerId),
        isNull(schema.customerSessions.revokedAt),
      ),
    )
    .returning({ id: schema.customerSessions.id });

  return result.length;
}
