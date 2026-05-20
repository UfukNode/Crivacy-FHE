/**
 * Credential pipeline worker — pg-boss job handler.
 *
 * Processes `credential-pipeline` jobs to mint credentials after
 * a Didit verification session is approved. The full pipeline:
 *
 *   1. Fetch the Didit decision payload via `getDecision()`
 *   2. Reduce the decision to `DiditVerificationFlags`
 *   3. Extract identity or address data from the decision
 *   4. Update the `customers` table with identity/address fields +
 *      KYC level + score
 *   5. Compute the proof hash for the credential
 *   6. Submit the credential to Sepolia MainNet via `createCredential()`
 *   7. Insert a `kyc_credentials_meta` row with the contract ID
 *   8. Write audit log entries for credential issuance + KYC completion
 *
 * The worker follows the same DI pattern as email-worker.ts: dependencies
 * are injected via `CredentialPipelineWorkerDeps` so the handler is
 * testable without hitting real services.
 *
 * Error handling: if the handler throws, pg-boss retries automatically
 * based on the job's retry configuration set at enqueue time.
 *
 * @module
 */

import type PgBoss from 'pg-boss';
import { and, eq, inArray } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import type { DiditConfig } from '@crivacy-fhe/adapter-didit/config';
import { getDiditConfig } from '@crivacy-fhe/adapter-didit/config';
import { isDiditErrorWithCode } from '@crivacy-fhe/adapter-didit/errors';
import { getDecision } from '@crivacy-fhe/adapter-didit/session';
import { reduceDecision, computeProofHash } from '@crivacy-fhe/adapter-didit/mapping';
import { asDiditSessionIdUnchecked } from '@crivacy-fhe/adapter-didit/types';
import { PULL_OVERWRITABLE_STATUSES } from '@crivacy-fhe/adapter-didit/status-mapping';
import { getRootLogger } from '@/lib/observability/logger';
import { type CustomerKycLevel, computeKycScore } from '@/lib/customer/score';
import { isCustomerKycLevel } from '@/lib/kyc/phase-registry';
import { getFheClient } from '@crivacy-fhe/credential';
import type { FheCredentialInput } from '@crivacy-fhe/credential';
import { requireCustomerWalletAddress, deriveB2bUserAddress } from '@/lib/fhe/customer-address';
import { writeAudit } from '@/lib/audit/writer';
import { systemActor } from '@/lib/audit/actors';
import { uuidTarget } from '@/lib/audit/targets';
import { EMPTY_CONTEXT } from '@/lib/audit/context';
import { createNotification } from '@/lib/notification';

/* ---------- Constants ---------- */

/** pg-boss queue name for credential pipeline jobs. */
export const CREDENTIAL_PIPELINE_QUEUE = 'credential-pipeline';

/** Credential validity: 1 year from issuance. */
const CREDENTIAL_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

/* ---------- Types ---------- */

/**
 * Customer-flow job payload — self-service KYC where the credential
 * is owned by the Crivacy self-service firm and `userRef = customer.id`.
 * The default shape: omitting `flow` is treated as `'customer'` for
 * backwards compat with already-enqueued jobs.
 */
export interface CustomerCredentialPipelineJob {
  readonly flow?: 'customer';
  readonly kycSessionId: string;
  readonly customerId: string;
  readonly diditSessionId: string;
  readonly phase: 'identity' | 'address';
}

/**
 * B2B job payload — firm-initiated KYC via `POST /api/v1/sessions`. No
 * customer row exists; `firmId` + `userRef` (firm-supplied) identify
 * the user. The B2B branch skips customer-row update / NFT mint /
 * customer notification but otherwise shares the same Didit fetch +
 * proof-hash + chain mint + meta INSERT pipeline. Sprint 5 — closes
 * the OAuth↔B2B blob disparity by ensuring `kyc_credentials_meta`
 * carries a row + `disclosure_blob_cache` for B2B sessions too.
 */
export interface B2bCredentialPipelineJob {
  readonly flow: 'b2b';
  readonly kycSessionId: string;
  readonly firmId: string;
  readonly userRef: string;
  readonly diditSessionId: string;
  readonly phase: 'identity' | 'address';
}

export type CredentialPipelineJob =
  | CustomerCredentialPipelineJob
  | B2bCredentialPipelineJob;

export interface CredentialPipelineWorkerDeps {
  readonly db: CrivacyDatabase;
  readonly logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/* ---------- KYC level resolution ---------- */

/**
 * Determine the new KYC level based on the phase that just completed
 * and the verification flags.
 *
 * Phase 1 (identity):
 *   - identity verified + liveness verified = kyc_3 (Biometric)
 *   - identity verified only = kyc_2 (Identity)
 *   - otherwise = kyc_1 (Registered)
 *
 * Phase 2 (address):
 *   - address verified = kyc_4 (Address)
 *   - otherwise = keep current level
 */
function resolveKycLevel(
  phase: 'identity' | 'address',
  flags: {
    identityVerified: boolean;
    livenessVerified: boolean;
    addressVerified: boolean;
  },
  currentLevel: string,
): CustomerKycLevel {
  if (phase === 'identity') {
    if (flags.identityVerified && flags.livenessVerified) {
      return 'kyc_3';
    }
    if (flags.identityVerified) {
      return 'kyc_2';
    }
    return 'kyc_1';
  }

  // Phase 2 (address)
  if (flags.addressVerified) {
    return 'kyc_4';
  }
  // Keep current level if address verification did not pass.
  // Sprint 9: validity check goes through the registry guard so the
  // level union has one SoT — the inline string array used to live
  // here was the third copy of the same list.
  if (isCustomerKycLevel(currentLevel)) {
    return currentLevel;
  }
  return 'kyc_0';
}

/**
 * Map a `CustomerKycLevel` to the credential level enum.
 *
 *   kyc_0..kyc_3 -> 'basic' (Phase 1 — identity + liveness)
 *   kyc_4        -> 'enhanced' (Phase 2 — adds proof of address)
 *
 * The level vocabulary is two-tier (basic / enhanced). The on-chain
 * `claims.values["io.crivacy/level"]` slot carries the string value
 * verbatim — `chain.VC.Credential`'s `ensure` clause only enforces
 * the claims map is non-empty, leaving the level vocabulary as an
 * application concern. Phase 1 mints land at `basic`; address verification
 * is what promotes the credential to `enhanced`.
 */
function customerLevelToCredentialLevel(level: CustomerKycLevel): 'basic' | 'enhanced' {
  switch (level) {
    case 'kyc_0':
    case 'kyc_1':
    case 'kyc_2':
    case 'kyc_3':
      return 'basic';
    case 'kyc_4':
      return 'enhanced';
  }
}

/* ---------- Worker ---------- */

/**
 * Process a single credential pipeline job. Dispatches by `flow` to
 * the customer-flow processor (default) or the B2B-flow processor.
 *
 * Exported for direct testing. The pg-boss handler wraps this.
 */
export async function processCredentialPipeline(
  deps: CredentialPipelineWorkerDeps,
  job: CredentialPipelineJob,
): Promise<void> {
  if (job.flow === 'b2b') {
    await processCredentialPipelineB2b(deps, job);
    return;
  }
  await processCredentialPipelineCustomer(deps, job);
}

/**
 * Customer-flow processor — self-service KYC that mints a credential
 * owned by the Crivacy self-service firm and updates `customers` row
 * with kyc_level / kyc_score / extracted PII.
 */
async function processCredentialPipelineCustomer(
  deps: CredentialPipelineWorkerDeps,
  job: CustomerCredentialPipelineJob,
): Promise<void> {
  const { db } = deps;
  const { kycSessionId, customerId, diditSessionId, phase } = job;
  const now = new Date();

  const logMeta: Record<string, unknown> = {
    kycSessionId,
    customerId,
    diditSessionId,
    phase,
  };

  deps.logger?.info('[credential-pipeline] Processing job', logMeta);

  // --- 1. Load Didit config ---
  let diditConfig: DiditConfig;
  try {
    diditConfig = getDiditConfig();
  } catch (err) {
    deps.logger?.error('[credential-pipeline] Didit config not available', {
      ...logMeta,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // --- 2. Fetch decision from Didit ---
  //
  // The pull-fallback in customer-kyc.ts mirrors this same shape: when
  // Didit returns 404 the upstream session has been deleted (operator
  // cleanup, retention policy) and no future call will ever recover it.
  // Without this short-circuit pg-boss retries the job 5× before giving
  // up — burning ~3 minutes of worker time and emitting 5 alarming error
  // lines for what is fundamentally a one-shot terminal state. By
  // recognising `not_found` here we mark the kyc_session expired in one
  // shot and return cleanly so pg-boss treats the job as completed.
  //
  // Crucially: only `'not_found'` short-circuits. `'service_unavailable'`
  // and `'unauthorized'` re-throw so pg-boss retries with backoff, which
  // is what we want during a Didit outage or rotated-credential window —
  // a transient failure must not flip every in-flight session to
  // `expired` and force every pending customer back to step zero.
  const sessionId = asDiditSessionIdUnchecked(diditSessionId);
  let decision: Awaited<ReturnType<typeof getDecision>>;
  try {
    decision = await getDecision(diditConfig, sessionId);
  } catch (err) {
    if (isDiditErrorWithCode(err, 'not_found')) {
      const updated = await db
        .update(schema.kycSessions)
        .set({
          status: 'expired',
          failureReason: 'Verification session no longer recognised by provider.',
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.kycSessions.kind, 'customer' as const),
            eq(schema.kycSessions.id, kycSessionId),
            inArray(schema.kycSessions.status, [...PULL_OVERWRITABLE_STATUSES]),
          ),
        )
        .returning({ id: schema.kycSessions.id });

      if (updated.length > 0) {
        await writeAudit(db, {
          action: 'customer.kyc_failed',
          actor: systemActor('credential-pipeline'),
          target: uuidTarget({ kind: 'customer', id: customerId }),
          context: EMPTY_CONTEXT,
          meta: {
            kycSessionId,
            phase,
            diditSessionId,
            reason: 'pipeline_didit_session_deleted',
            diditErrorCode: 'not_found',
          },
          ts: now,
        });
        getRootLogger().info(
          {
            event: 'credential_pipeline_didit_session_deleted',
            kycSessionId,
            customerId,
            diditSessionId,
            phase,
          },
          '[credential-pipeline] Didit session deleted — marked kyc_session expired and exiting cleanly (no retry)',
        );
      } else {
        deps.logger?.info(
          '[credential-pipeline] Didit returned not_found but session already in terminal state — no-op',
          {
            ...logMeta,
            diditErrorCode: 'not_found',
          },
        );
      }
      return;
    }
    deps.logger?.error('[credential-pipeline] getDecision failed (transient) — re-throwing for pg-boss retry', {
      ...logMeta,
      error: err instanceof Error ? err.message : String(err),
      diditErrorCode: err instanceof Error && 'code' in err ? (err as { code?: string }).code : undefined,
    });
    throw err;
  }

  deps.logger?.info('[credential-pipeline] Decision fetched', {
    ...logMeta,
    diditStatus: decision.status,
    workflowType: decision.workflowType,
  });

  // --- 3. Reduce to verification flags ---
  const flags = reduceDecision(decision);

  if (flags.outcome !== 'passed') {
    deps.logger?.info('[credential-pipeline] Decision not passed, skipping credential creation', {
      ...logMeta,
      outcome: flags.outcome,
    });
    return;
  }

  // --- 4. Load the customer ---
  const customerRows = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId))
    .limit(1);

  const customer = customerRows[0];
  if (customer === undefined) {
    deps.logger?.error('[credential-pipeline] Customer not found', logMeta);
    throw new Error(`Customer not found: ${customerId}`);
  }

  // --- 4b. Customer status gate (post-load, pre-mint) ---------------
  //
  // Didit decision was approved but the customer may have been
  // banned/suspended/locked between session start and decision
  // delivery (e.g. SOC banned the user during the verification
  // window, fraud signal fired between hand-off and webhook).
  // Minting a credential for a banned customer would
  // permanently bind their on-chain identity to a state we
  // explicitly disallow at the application layer; the chain
  // contract outlives the ban toggle and cannot be retracted
  // without an explicit revoke.
  //
  // Short-circuit here for any non-active status so the SOC
  // decision wins. The Didit decision payload is preserved on
  // the kyc_session row for replay once the operator clears
  // the customer.
  if (customer.status !== 'active' && customer.status !== 'pending_verification') {
    deps.logger?.info(
      '[credential-pipeline] Customer not eligible for credential mint — skipping',
      {
        ...logMeta,
        customerStatus: customer.status,
      },
    );
    await writeAudit(db, {
      action: 'customer.kyc_failed',
      actor: systemActor('credential-pipeline'),
      target: uuidTarget({ kind: 'customer', id: customerId }),
      context: EMPTY_CONTEXT,
      meta: {
        customerStatus: customer.status,
        phase,
        kycSessionId,
        reason: 'customer_status_blocks_mint',
      },
      ts: now,
    });
    return;
  }

  // --- 4a. Double-mint / replay guard (identity phase only) --------
  //
  // pg-boss's `singletonKey` dedups jobs that are still
  // `created`/`active`/`retry`; once a job reaches `completed`,
  // the same `(kycSessionId, phase)` key can enqueue a fresh
  // job. That happens when Didit redelivers the webhook after
  // the 2-hour job TTL (manual replay, network partition
  // resend, operator-triggered retry). Without a guard the
  // worker would run the whole pipeline end-to-end a second
  // time:
  //
  //   * chain `createCredential` mints a second on-chain
  //     contract for the same user — real gas, real storage,
  //     permanent drift between chain and DB.
  //   * The eventual INSERT into `kyc_credentials_meta` trips
  //     the `kyc_credentials_meta_firm_user_active_key` partial
  //     unique index, pg-boss treats it as a job failure and
  //     retries, producing a loop that only stops at the
  //     retryLimit ceiling.
  //
  // Short-circuit here if a `pending`/`active` credential
  // already exists for this customer under the self-service
  // firm. Phase `address` deliberately bypasses this guard —
  // that phase supersedes the phase 1 credential via the block
  // further down (chain revoke + DB status flip); skipping
  // here would prevent the upgrade.
  if (phase === 'identity') {
    const selfServiceFirmId = process.env['CRIVACY_SELF_SERVICE_FIRM_ID'];
    if (selfServiceFirmId !== undefined && selfServiceFirmId.length > 0) {
      const existingRows = await db
        .select({
          id: schema.kycCredentialsMeta.id,
          chainContractId: schema.kycCredentialsMeta.chainContractId,
          level: schema.kycCredentialsMeta.level,
          status: schema.kycCredentialsMeta.status,
        })
        .from(schema.kycCredentialsMeta)
        .where(
          and(
            eq(schema.kycCredentialsMeta.firmId, selfServiceFirmId),
            eq(schema.kycCredentialsMeta.userRef, customerId),
            inArray(schema.kycCredentialsMeta.status, ['pending', 'active']),
          ),
        )
        .limit(1);

      if (existingRows.length > 0) {
        const existing = existingRows[0]!;
        deps.logger?.info(
          '[credential-pipeline] Active identity credential already exists — skipping duplicate delivery',
          {
            ...logMeta,
            existingCredentialId: existing.id,
            existingContractId: existing.chainContractId,
            existingLevel: existing.level,
            existingStatus: existing.status,
          },
        );
        return;
      }
    }
  }

  // --- 4b. Phase 2 replay guard ----------------------------------------
  //
  // Phase 1's guard above triggers on "any pending/active credential
  // exists for this customer" — that's the right check for Phase 1
  // because a fresh basic credential should never overwrite an
  // existing one. Phase 2 deliberately walks past it (the supersede
  // block downstream needs to see the existing Phase 1 row), but
  // that exposes a different replay surface: when the SAME Phase 2
  // webhook is redelivered after the original job completed, the
  // pipeline would (a) mint a second chain contract, (b) treat the
  // first Phase 2 credential as the "existing" one to supersede,
  // and (c) issue an on-chain revoke against the credential it just
  // produced moments earlier. Net: chain drift + cascade-burned NFT.
  //
  // The durable replay key is the source `kyc_session_id` — every
  // credential row carries its originating session, and pg-boss
  // re-enqueues the same job after singleton expiry (operator
  // replay, post-TTL Didit resend). Short-circuit if the session
  // has already produced a credential meta row, regardless of its
  // current status.
  if (phase === 'address') {
    const sessionMatchRows = await db
      .select({
        id: schema.kycCredentialsMeta.id,
        chainContractId: schema.kycCredentialsMeta.chainContractId,
        status: schema.kycCredentialsMeta.status,
      })
      .from(schema.kycCredentialsMeta)
      .where(eq(schema.kycCredentialsMeta.kycSessionId, kycSessionId))
      .limit(1);

    if (sessionMatchRows.length > 0) {
      const existing = sessionMatchRows[0]!;
      deps.logger?.info(
        '[credential-pipeline] Credential already minted for this Phase 2 session — skipping duplicate delivery',
        {
          ...logMeta,
          existingCredentialId: existing.id,
          existingContractId: existing.chainContractId,
          existingStatus: existing.status,
        },
      );
      return;
    }
  }

  // --- 5. Lifecycle gate: lock the kyc_fields_locked flag on first
  //        successful identity-phase mint. PII is intentionally NOT
  //        written here — Crivacy stores zero raw PII columns post
  //        migration 20260509000000. The hash committing to the PII
  //        is computed downstream in step 7 (computeProofHash) from
  //        the Didit decision payload directly, never via a DB cache.
  if (phase === 'identity' && !customer.kycFieldsLocked) {
    await db
      .update(schema.customers)
      .set({
        kycFieldsLocked: true,
        updatedAt: now,
      })
      .where(eq(schema.customers.id, customerId));
  }
  // Phase 2 (address): no per-row PII update either — same reason.

  // --- 6. Resolve new KYC level and score ---
  // Sprint 7 Phase I — kyc_level/kyc_score is no longer UPDATEd here.
  // The bump happens INSIDE the same DB transaction as the meta
  // INSERT below (step 10), so a chain-mint failure between this
  // point and the meta INSERT can no longer leave `customers` with a
  // stale `kyc_level` pointing at a credential that never existed.
  // The legacy 4+ bug class (kyc_level=kyc_3 without a chain
  // contract or kyc_credentials_meta row) is impossible by
  // construction post Phase I.
  const newLevel = resolveKycLevel(phase, flags, customer.kycLevel);
  const newScore = computeKycScore(newLevel);

  // --- 7. Compute proof hash ---
  const proofHash = computeProofHash(diditConfig, decision);

  // --- 8. Issue the encrypted credential on-chain (Zama FHEVM / Sepolia) ---
  let fhe: ReturnType<typeof getFheClient>;
  try {
    fhe = getFheClient();
  } catch (err) {
    deps.logger?.error('[credential-pipeline] FHE client not available', {
      ...logMeta,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const fheConfig = fhe.config;

  // The credential is user-owned: it is keyed by the customer's own EVM wallet
  // address (proven via SIWE at link time), NOT a custodial synthetic party as
  // under chain. A customer without a linked wallet cannot receive a
  // credential — `requireCustomerWalletAddress` throws, the job retries once
  // the wallet is linked.
  const userAddress = await requireCustomerWalletAddress(db, customerId);

  // --- 8b. Phase-2 wallet-consistency guard (defense-in-depth) ---
  //
  // The address phase UPGRADES the phase-1 credential in place, keyed by
  // the customer's CURRENT wallet, so it relies on `_cred[userAddress]`
  // already holding the phase-1 identity credential. In normal flow the
  // start-address wallet gate + the unlink-with-active-credential guard
  // guarantee the wallet is unchanged since the identity mint. If it is
  // NOT (a wallet swapped out-of-band, e.g. an operator DB edit), minting
  // here would write `_cred[newWallet]` while the phase-1 record at the old
  // wallet is left orphaned on-chain — a split credential. Refuse instead.
  //
  // `null` = RPC succeeded but no record at this address (genuine mismatch)
  // → abort. RPC error → `undefined` → fail OPEN so a flaky endpoint never
  // blocks a legitimate upgrade.
  if (phase === 'address') {
    let identityOnChain: Awaited<ReturnType<typeof fhe.fetchCredential>> | undefined;
    try {
      identityOnChain = await fhe.fetchCredential(userAddress);
    } catch (checkErr) {
      identityOnChain = undefined;
      deps.logger?.error(
        '[credential-pipeline] Phase-2 consistency check RPC error — proceeding (fail-open)',
        {
          ...logMeta,
          userAddress,
          error: checkErr instanceof Error ? checkErr.message : String(checkErr),
        },
      );
    }
    if (identityOnChain === null) {
      deps.logger?.error(
        '[credential-pipeline] Phase-2 wallet mismatch — no identity credential at current wallet; aborting to avoid a split credential',
        { ...logMeta, userAddress },
      );
      await writeAudit(db, {
        action: 'credential.chain_error',
        actor: systemActor('credential-pipeline'),
        target: uuidTarget({ kind: 'customer', id: customerId }),
        context: EMPTY_CONTEXT,
        meta: {
          operation: 'phase2_wallet_consistency',
          userAddress,
          reason: 'no_onchain_identity_credential_at_current_wallet',
        },
        ts: now,
      });
      throw new Error(
        `[credential-pipeline] phase-2 abort: customer ${customerId} has no on-chain ` +
          `identity credential at current wallet ${userAddress} — the wallet changed since ` +
          `the identity mint; refusing to mint a split credential.`,
      );
    }
  }

  const credentialLevel = customerLevelToCredentialLevel(newLevel);
  const validUntil = new Date(now.getTime() + CREDENTIAL_VALIDITY_MS);

  // `sanctioned` is false by construction at mint time: the pipeline only mints
  // for an APPROVED, fraud-screened decision. Any fraud / blocklist signal is
  // caught upstream (didit-webhook + lib/fraud) and routes to decline / revoke
  // BEFORE the credential reaches this point, so a minted credential is not
  // flagged. If Didit AML is later wired as a soft-flag (mint-but-mark), source
  // this from that screening result instead.
  const fheInput: FheCredentialInput = {
    userAddress,
    // Self-service mints bind the credential to the customer's Crivacy UUID;
    // B2B mints bind to the firm-supplied userRef.
    userRef: customerId,
    proofHash,
    level: credentialLevel,
    humanScore: flags.humanScore,
    identityVerified: flags.identityVerified,
    livenessVerified: flags.livenessVerified,
    addressVerified: flags.addressVerified,
    sanctioned: false,
    validator: 'didit',
    validUntil,
  };

  const fheResult = await fhe.createCredential(fheInput);

  deps.logger?.info('[credential-pipeline] FHE credential created', {
    ...logMeta,
    userAddress: fheResult.userAddress,
    txHash: fheResult.txHash,
  });

  // Cache the on-chain ciphertext handles right after issuance — the FHE
  // analogue of the chain `createdEventBlob`. A relying firm reads these
  // handles from the chain and decrypts the eligibility verdict with the ACL
  // grant Crivacy issued it. Stored as UTF-8 JSON in
  // `kyc_credentials_meta.disclosure_blob_cache`. Failures here are non-fatal:
  // the row still lands with a `null` blob and the reconciler tops it up.
  let disclosureBlobCache: Uint8Array | null = null;
  let disclosureBlobFetchedAt: Date | null = null;
  try {
    const onchain = await fhe.fetchCredential(userAddress);
    if (onchain !== null) {
      disclosureBlobCache = Buffer.from(JSON.stringify(onchain.handles), 'utf8');
      disclosureBlobFetchedAt = now;
      deps.logger?.info('[credential-pipeline] Ciphertext handles cached', {
        ...logMeta,
        userAddress,
        blobBytes: disclosureBlobCache.length,
      });
    } else {
      deps.logger?.error(
        '[credential-pipeline] On-chain credential missing immediately after mint',
        { ...logMeta, userAddress },
      );
    }
  } catch (blobErr) {
    const blobErrMsg = blobErr instanceof Error ? blobErr.message : String(blobErr);
    deps.logger?.error('[credential-pipeline] Failed to fetch ciphertext handles', {
      ...logMeta,
      userAddress,
      error: blobErrMsg,
    });
    await writeAudit(db, {
      action: 'credential.chain_error',
      actor: systemActor('credential-pipeline'),
      target: uuidTarget({ kind: 'customer', id: customerId }),
      context: EMPTY_CONTEXT,
      meta: {
        operation: 'fetch_ciphertext_handles',
        userAddress,
        error: blobErrMsg,
        recovery: 'non_fatal_reconciler_will_retry',
      },
      ts: now,
    });
  }

  // --- 9. If this is phase 2, supersede the phase 1 credential ---
  // Find any existing active credential for this customer (from phase 1) and
  // mark it superseded in the DB. No on-chain revoke is needed: `setCredential`
  // in step 8 keyed the record by the customer's EVM address, so the phase-2
  // issuance already OVERWROTE the phase-1 on-chain state (single record per
  // user). The soulbound NFT is per-customer and persists across the upgrade,
  // so it is not burned here.
  if (phase === 'address') {
    const { and: drizzleAnd } = await import('drizzle-orm');
    const existingCreds = await db
      .select()
      .from(schema.kycCredentialsMeta)
      .where(
        drizzleAnd(
          eq(schema.kycCredentialsMeta.userRef, customerId),
          eq(schema.kycCredentialsMeta.status, 'active'),
        ),
      )
      .limit(10);

    for (const existing of existingCreds) {
      if (existing.chainContractId !== fheResult.txHash) {
        // Flip old credential to `superseded` BEFORE the new INSERT.
        //
        // The partial unique index `kyc_credentials_meta_firm_user_active_key`
        // restricts (firm_id, user_ref) to a single row whose status is
        // in ('pending', 'active'). If we left the old row 'active'
        // until after the new insert, step 10's INSERT would trip
        // 23505. The `supersededBy` FK is filled in later (step 10b)
        // because we need the new credential's UUID first; setting it
        // to NULL here is fine — the column is nullable.
        await db
          .update(schema.kycCredentialsMeta)
          .set({
            status: 'superseded',
            revokedAt: now,
            revokedReason: 'Superseded by address verification upgrade',
            updatedAt: now,
          })
          .where(eq(schema.kycCredentialsMeta.id, existing.id));
      }
    }

    // Store old credential IDs to fill `superseded_by` AFTER the new
    // credential is inserted (the FK points to the new credential's
    // UUID, which only exists after step 10).
    (logMeta as Record<string, unknown>)['_oldCredsToSupersede'] = existingCreds
      .filter((c) => c.chainContractId !== fheResult.txHash)
      .map((c) => c.id);
  }

  // --- 10. Insert credential meta row ---
  // For customer credentials, `firmId` is a sentinel value since the
  // `kycCredentialsMeta` table has a NOT NULL FK to `firms`. Customer
  // credentials are stored with the customer's own UUID in `userRef`
  // and a dedicated "customer-self" firm record or the operator's firm.
  // Since customers are not firms, we use a well-known self-service
  // firm ID that is set up during initial deployment. For now we use
  // the customer ID as the userRef and a configurable env var for the
  // self-service firm.
  const selfServiceFirmId = process.env['CRIVACY_SELF_SERVICE_FIRM_ID'];
  if (selfServiceFirmId === undefined || selfServiceFirmId.length === 0) {
    deps.logger?.error(
      '[credential-pipeline] CRIVACY_SELF_SERVICE_FIRM_ID not set, cannot store credential meta',
      logMeta,
    );
    throw new Error(
      'CRIVACY_SELF_SERVICE_FIRM_ID environment variable is required for customer credential storage',
    );
  }

  const { createCredential: insertCredentialMeta } = await import(
    '@/server/repositories/credentials'
  );

  // Resolve the proof_schemas FK BEFORE the insert. Sprint 1: every
  // mint references kyc-v1 (single-workflow proof), regardless of
  // phase. Sprint 2 introduces the kyc+address-v1 composite spec; at
  // that point the chain literal here switches to a phase-aware
  // selection. Throws if the spec row is missing — `seedProofSchemas`
  // on worker boot guarantees presence.
  const { resolveProofSchemaId } = await import('@/lib/proof-schemas');
  const proofSchemaId = await resolveProofSchemaId(
    db,
    phase === 'identity' ? 'kyc' : 'address',
    'v1',
  );

  // The chain contract is already minted at this point. If the DB
  // insert fails (constraint violation, connection drop, deadlock),
  // the chain holds a contract that has no off-chain mirror — the
  // partial unique index `kyc_credentials_meta_firm_user_active_key`
  // would prevent recovery on retry because no row exists for the
  // pipeline to recognise as "already present", but chain still
  // owns the artefact and would mint a fresh one on the next
  // attempt. To keep ledger ↔ DB in lockstep, attempt a
  // compensating revoke against the just-minted contract id, then
  // re-throw so pg-boss retries the job from scratch (next attempt
  // will mint a fresh contract on a clean state).
  // Sprint 7 Phase I — meta INSERT + customers.kyc_level/score UPDATE
  // run in the same DB transaction. Either both rows commit or both
  // roll back. The chain contract is already minted at this point;
  // the compensating-revoke catch path below handles the
  // chain-mints-but-DB-fails scenario (the chain-side artefact must
  // not be left orphaned, but pg-boss will retry the whole job after
  // we revoke).
  let credentialMeta: Awaited<ReturnType<typeof insertCredentialMeta>>;
  try {
    credentialMeta = await db.transaction(async (tx) => {
      // Column names are still the legacy `chain_*` (renamed to `fhe_*` in a
      // later cleanup pass); the VALUES are FHE / EVM data:
      //   chainContractId  -> the setCredential tx hash (unique per mint)
      //   chainTemplateId  -> the CrivacyKYC contract address
      //   operatorParty     -> operator EVM address
      //   userParty         -> the customer's EVM address (the on-chain key)
      //   chainSubmissionId / chainUpdateId -> the tx hash (Etherscan deep-link)
      const inserted = await insertCredentialMeta(tx, {
        firmId: selfServiceFirmId,
        userRef: customerId,
        kycSessionId,
        chainContractId: fheResult.txHash,
        chainPackageName: 'crivacy-fhe-v1',
        chainTemplateId: fheConfig.kycAddress,
        chainNetwork: fheConfig.networkLabel as 'mainnet' | 'devnet' | 'sepolia',
        operatorParty: fheConfig.operatorAddress,
        userParty: userAddress,
        level: credentialLevel,
        validator: 'didit',
        proofHash,
        proofSchemaId,
        humanScore: flags.humanScore,
        identityVerified: flags.identityVerified ? 1 : 0,
        livenessVerified: flags.livenessVerified ? 1 : 0,
        addressVerified: flags.addressVerified ? 1 : 0,
        validUntil,
        confirmedAt: now,
        disclosureBlobCache,
        disclosureBlobFetchedAt,
        chainSubmissionId: fheResult.txHash,
        chainUpdateId: fheResult.txHash,
      });

      // Atomic bump of `customers.kyc_level` + `kyc_score` plus
      // decline-counter reset. If the INSERT above succeeded but this
      // UPDATE throws (RLS, deadlock, disk-full, …), the TX rolls back
      // the meta INSERT too, so the customer's status stays consistent:
      // no half-flipped level pointing at a credential row that
      // doesn't exist. The decline counter is folded into the same
      // SET so it cannot diverge: an approved credential always means
      // a clean counter, atomically.
      await tx
        .update(schema.customers)
        .set({
          kycLevel: newLevel,
          kycScore: newScore,
          consecutiveKycDeclines: 0,
          lastDeclineAt: null,
          updatedAt: now,
        })
        .where(eq(schema.customers.id, customerId));

      return inserted;
    });

    deps.logger?.info('[credential-pipeline] Customer KYC level updated atomically with meta INSERT', {
      ...logMeta,
      newLevel,
      newScore,
    });

    // Decline-counter reset audit. The actual reset happened inside
    // the TX above (folded into the same SET as the level/score
    // bump); this row only fires when the counter was non-zero so
    // the SOC sees one signal per real reset instead of one per
    // approval. `customer.consecutiveKycDeclines` is the pre-TX
    // value (we read it at step 4 above), which is exactly the
    // "previous count" the audit row carries.
    if (customer.consecutiveKycDeclines > 0) {
      await writeAudit(db, {
        action: 'fraud.kyc_decline_reset',
        actor: systemActor('decline-counter:approve'),
        target: uuidTarget({ kind: 'customer', id: customerId }),
        context: EMPTY_CONTEXT,
        meta: {
          kycSessionId,
          previousCount: customer.consecutiveKycDeclines,
        },
        ts: now,
      });
    }
  } catch (insertErr) {
    const insertErrMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
    deps.logger?.error(
      '[credential-pipeline] DB insert failed after on-chain mint — running compensating revoke',
      {
        ...logMeta,
        userAddress,
        txHash: fheResult.txHash,
        error: insertErrMsg,
      },
    );

    let compensatingRevokeStatus: 'succeeded' | 'failed' = 'failed';
    let compensatingRevokeError: string | undefined;
    try {
      // Undo the mint so the retry re-issues cleanly. burnNft = false: the NFT
      // is minted separately (user-triggered) and does not exist yet.
      await fhe.revokeCredential(userAddress, false);
      compensatingRevokeStatus = 'succeeded';
      deps.logger?.info('[credential-pipeline] Compensating revoke succeeded', {
        ...logMeta,
        userAddress,
      });
    } catch (revokeErr) {
      compensatingRevokeError = revokeErr instanceof Error ? revokeErr.message : String(revokeErr);
      deps.logger?.error(
        '[credential-pipeline] Compensating revoke FAILED — manual chain cleanup required',
        {
          ...logMeta,
          userAddress,
          error: compensatingRevokeError,
        },
      );
    }

    await writeAudit(db, {
      action: 'credential.chain_error',
      actor: systemActor('credential-pipeline'),
      target: uuidTarget({ kind: 'customer', id: customerId }),
      context: EMPTY_CONTEXT,
      meta: {
        operation: 'insert_credential_meta',
        userAddress,
        txHash: fheResult.txHash,
        insertError: insertErrMsg,
        compensatingRevoke: compensatingRevokeStatus,
        ...(compensatingRevokeError !== undefined
          ? { compensatingRevokeError: compensatingRevokeError }
          : {}),
        recovery:
          compensatingRevokeStatus === 'succeeded'
            ? 'chain_state_clean_pg_boss_will_retry'
            : 'orphan_record_requires_manual_revoke',
      },
      ts: now,
    });

    throw insertErr;
  }

  deps.logger?.info('[credential-pipeline] Credential meta stored', {
    ...logMeta,
    credentialMetaId: credentialMeta.id,
    txHash: fheResult.txHash,
  });

  // --- 10c. NFT mint moved to user-triggered path (2026-05-07) ------
  //
  // The KycNFT is a customer-facing soulbound artefact: a personal
  // display piece, not a compliance / verification artefact. The
  // compliance artefact is the `chain.VC.Credential` minted above;
  // firms verify against that (via `Credential_PublicFetch`), and they
  // don't need the NFT to exist for the verification surface to work.
  //
  // Because the NFT carries a customer-chosen theme variant (light vs
  // dark, written immutably onto chain at mint time as inline SVG
  // bytes), it cannot be auto-minted from this background worker —
  // that would deny the customer their choice. Instead the customer
  // picks the theme on the /kyc step 4 surface and clicks "Mint" which
  // hits `POST /api/customer/credential/mint-nft` (handler:
  // `lib/customer/mint-nft.ts`). That endpoint enforces the same
  // chain-level invariants: level == 'enhanced', credential still
  // active, no NFT already minted (CAS guard).
  //
  // For pre-2026-05-07 customers who reached Enhanced before the
  // user-triggered flow shipped, the same endpoint is also the only
  // way to mint — they see the theme picker on /kyc step 4 the next
  // time they visit, with their existing Enhanced credential awaiting.

  // Dispatch `credential.created` + `credential.verified` to every
  // firm the customer has an active relationship with. Both events
  // fire at the same instant because — by the time the meta row
  // lands in the DB — the underlying chain transaction has already
  // been confirmed on-chain (it's what produced `contractId`). We
  // still emit both so firms can subscribe at whichever semantic
  // layer matches their mental model.
  try {
    const { emitUserEvent } = await import('@/lib/webhook');
    const { fromKycCredentialMetaRow, toWebhookPayload } = await import(
      '@/lib/credentials/view'
    );
    // Project the freshly-inserted row through the canonical view so
    // every firm-bound webhook payload (`credential.created` /
    // `credential.verified` here, `credential.upgraded` below) carries
    // the same canonical field set — including the disclosure blob
    // inline (base64url) — instead of each call site cherry-picking
    // its own subset.
    const credentialPayload = toWebhookPayload(fromKycCredentialMetaRow(credentialMeta));
    await emitUserEvent(db, {
      customerId,
      ownerFirmId: selfServiceFirmId,
      type: 'credential.created',
      payload: { ...credentialPayload, createdAt: now.toISOString() },
      sourceCredentialId: credentialMeta.id,
      idempotencyKey: `created:${credentialMeta.id}`,
      now,
    });
    await emitUserEvent(db, {
      customerId,
      ownerFirmId: selfServiceFirmId,
      type: 'credential.verified',
      payload: { ...credentialPayload, verifiedAt: now.toISOString() },
      sourceCredentialId: credentialMeta.id,
      idempotencyKey: `verified:${credentialMeta.id}`,
      now,
    });
  } catch (webhookErr) {
    deps.logger?.error('[credential-pipeline] credential.created/verified dispatch failed', {
      ...logMeta,
      error: webhookErr instanceof Error ? webhookErr.message : String(webhookErr),
    });
  }

  // --- 10a. Create in-app notification for the customer ---
  try {
    await createNotification(db, {
      customerId,
      type: 'credential.issued',
      title: 'Credential Issued',
      body: `Your identity credential has been issued at level ${credentialLevel}.`,
      link: '/credential',
    });
    deps.logger?.info('[credential-pipeline] Notification created for customer', logMeta);
  } catch (notifErr) {
    // Notification failure is non-fatal — the credential was already created
    deps.logger?.error('[credential-pipeline] Failed to create notification', {
      ...logMeta,
      error: notifErr instanceof Error ? notifErr.message : String(notifErr),
    });
  }

  // --- 10b. Finalize supersede: update old credentials with supersededBy ---
  if (phase === 'address') {
    const oldCredIds = (logMeta as Record<string, unknown>)['_oldCredsToSupersede'] as
      | string[]
      | undefined;

    if (oldCredIds !== undefined && oldCredIds.length > 0) {
      for (const oldCredId of oldCredIds) {
        // Status was already flipped to 'superseded' in step 9b before
        // the new INSERT (so the partial unique index didn't trip).
        // This second UPDATE only fills the cross-reference FK that
        // had to wait for the new credential's UUID.
        await db
          .update(schema.kycCredentialsMeta)
          .set({
            supersededBy: credentialMeta.id,
            updatedAt: now,
          })
          .where(eq(schema.kycCredentialsMeta.id, oldCredId));

        deps.logger?.info('[credential-pipeline] Old credential superseded in DB', {
          ...logMeta,
          oldCredentialId: oldCredId,
          supersededBy: credentialMeta.id,
        });

        // Audit: old credential superseded
        await writeAudit(db, {
          action: 'customer.credential_superseded',
          actor: systemActor('credential-pipeline'),
          target: uuidTarget({ kind: 'credential', id: oldCredId }),
          context: EMPTY_CONTEXT,
          meta: {
            customerId,
            oldCredentialId: oldCredId,
            newCredentialId: credentialMeta.id,
            newLevel: credentialLevel,
            reason: 'address_verification_upgrade',
          },
          ts: now,
        });
      }

      // Audit: new credential upgraded
      await writeAudit(db, {
        action: 'customer.credential_upgraded',
        actor: systemActor('credential-pipeline'),
        target: uuidTarget({
          kind: 'credential',
          id: credentialMeta.id,
          ref: fheResult.txHash,
        }),
        context: EMPTY_CONTEXT,
        meta: {
          customerId,
          kycSessionId,
          previousLevel: customer.kycLevel,
          newLevel,
          newScore,
          supersededCredentialIds: oldCredIds,
          txHash: fheResult.txHash,
        },
        ts: now,
      });

      // Dispatch `credential.upgraded` via the central emitter so
      // every firm the customer has a relationship with (OAuth
      // consent or prior B2B credential) hears about the level
      // bump, not just the self-service firm. Payload is the canonical
      // credential view + the upgrade-specific extras (previous level,
      // new score, the superseded credential IDs) layered on top.
      try {
        const { emitUserEvent } = await import('@/lib/webhook');
        const { fromKycCredentialMetaRow, toWebhookPayload } = await import(
          '@/lib/credentials/view'
        );
        const credentialPayload = toWebhookPayload(fromKycCredentialMetaRow(credentialMeta));
        const result = await emitUserEvent(db, {
          customerId,
          ownerFirmId: selfServiceFirmId,
          type: 'credential.upgraded',
          payload: {
            ...credentialPayload,
            previousLevel: customer.kycLevel,
            newLevel: credentialLevel,
            newScore,
            supersededCredentialIds: oldCredIds,
          },
          sourceCredentialId: credentialMeta.id,
          idempotencyKey: `upgrade:${kycSessionId}:${phase}`,
          now,
        });

        deps.logger?.info('[credential-pipeline] credential.upgraded webhook dispatched', {
          ...logMeta,
          webhookEventId: result.eventId,
          deliveryCount: result.deliveryCount,
        });
      } catch (webhookErr) {
        // Webhook dispatch failure is non-fatal — the credential was
        // already created and superseded successfully. Log and continue.
        deps.logger?.error('[credential-pipeline] Failed to dispatch credential.upgraded webhook', {
          ...logMeta,
          error: webhookErr instanceof Error ? webhookErr.message : String(webhookErr),
        });
      }
    }
  }

  // --- 11. Write audit logs ---
  const actor = systemActor('credential-pipeline');
  const target = uuidTarget({
    kind: 'credential',
    id: credentialMeta.id,
    ref: fheResult.txHash,
  });

  await writeAudit(db, {
    action: 'customer.credential_issued',
    actor,
    target,
    context: EMPTY_CONTEXT,
    meta: {
      customerId,
      kycSessionId,
      phase,
      level: credentialLevel,
      humanScore: flags.humanScore,
      txHash: fheResult.txHash,
    },
    ts: now,
  });

  await writeAudit(db, {
    action: 'customer.kyc_completed',
    actor,
    target: uuidTarget({ kind: 'customer', id: customerId }),
    context: EMPTY_CONTEXT,
    meta: {
      kycSessionId,
      phase,
      previousLevel: customer.kycLevel,
      newLevel,
      newScore,
    },
    ts: now,
  });

  deps.logger?.info('[credential-pipeline] Job completed successfully', logMeta);
}

/* ---------- pg-boss registration ---------- */

/**
 * Register the credential pipeline job handler with pg-boss.
 *
 * @param boss - pg-boss instance
 * @param deps - Worker dependencies
 * @returns pg-boss worker ID
 */
export async function registerCredentialPipelineWorker(
  boss: PgBoss,
  deps: CredentialPipelineWorkerDeps,
): Promise<string> {
  // Seed proof_schemas from PROOF_SCHEMA_DEFS BEFORE accepting any
  // mint jobs. seedProofSchemas is idempotent + safe under concurrent
  // boots (no-ops on already-present rows; throws on schema drift so
  // a developer who edited an existing def instead of bumping the
  // version sees the failure immediately, NOT silently mints under a
  // mismatched spec).
  const { seedProofSchemas } = await import('@/lib/proof-schemas');
  await seedProofSchemas(deps.db);

  // pg-boss v10 dropped auto-create-on-send/work: `boss.send()` to an
  // unregistered queue returns null and the mint job is silently lost.
  // Unlike the cron workers (which register their queue via
  // `boss.schedule()`), this queue is purely event-driven, so it must
  // be created explicitly here — mirrors credential-expire-worker.
  // Idempotent, safe on every boot. Without this the credential-pipeline
  // queue never existed and every enqueueCredentialPipeline() dropped
  // its job, leaving KYC sessions stuck at "still processing" forever.
  await boss.createQueue(CREDENTIAL_PIPELINE_QUEUE);

  return boss.work<CredentialPipelineJob>(
    CREDENTIAL_PIPELINE_QUEUE,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        // Loud error log around the per-job processor so a thrown
        // exception (e.g. `DiditError('invalid_proof_input', …)` from
        // a missing decision field) surfaces to the dev workers'
        // stdout instead of being eaten by pg-boss's internal handler.
        // Pre-2026-05-10 trauma: an `invalid_proof_input` from
        // `computeProofHash` (V3 PoA payload had no top-level
        // `country`, only inside `poa_parsed_address`) silently
        // retried the address-phase mint forever — 5 live attempts +
        // $1.00 + 4 hours of debugging — because nothing logged the
        // throw between "Decision fetched" and the next retry.
        try {
          await processCredentialPipeline(deps, job.data);
        } catch (err) {
          deps.logger?.error('[credential-pipeline] Job failed — re-throwing for pg-boss retry', {
            jobId: job.id,
            jobData: job.data,
            error:
              err instanceof Error
                ? { name: err.name, message: err.message, stack: err.stack }
                : String(err),
          });
          throw err;
        }
      }
    },
  );
}

/* ---------- B2B-flow processor ---------- */

/**
 * B2B-flow processor — firm-initiated KYC where the credential is
 * owned by the calling firm and `userRef` is opaque to Crivacy. Mirrors
 * the customer flow's chain mint + meta INSERT path but skips the
 * customer-row UPDATE / NFT mint / customer notification steps that
 * have no counterpart for B2B (no `customers` row exists for the user).
 *
 * Failure semantics match the customer flow: a chain mint that
 * succeeds but a DB INSERT that fails triggers a compensating revoke
 * so the chain ↔ DB stay in lockstep.
 *
 * Idempotency: the Didit webhook handler already updates
 * `kyc_sessions.status='approved'` before enqueueing this job. A
 * webhook redelivery would re-enqueue, so the first work step is a
 * `(firmId, userRef, status in pending|active)` guard that no-ops on
 * re-runs.
 */
async function processCredentialPipelineB2b(
  deps: CredentialPipelineWorkerDeps,
  job: B2bCredentialPipelineJob,
): Promise<void> {
  const { db } = deps;
  const { kycSessionId, firmId, userRef, diditSessionId, phase } = job;
  const now = new Date();

  const logMeta: Record<string, unknown> = {
    flow: 'b2b',
    kycSessionId,
    firmId,
    userRef,
    diditSessionId,
    phase,
  };

  deps.logger?.info('[credential-pipeline-b2b] Processing job', logMeta);

  // --- 1. Idempotency guard — webhook redelivery → already-minted? -----
  const existingRows = await db
    .select({
      id: schema.kycCredentialsMeta.id,
      status: schema.kycCredentialsMeta.status,
      chainContractId: schema.kycCredentialsMeta.chainContractId,
    })
    .from(schema.kycCredentialsMeta)
    .where(
      and(
        eq(schema.kycCredentialsMeta.firmId, firmId),
        eq(schema.kycCredentialsMeta.userRef, userRef),
        inArray(schema.kycCredentialsMeta.status, ['pending', 'active']),
      ),
    )
    .limit(1);
  if (existingRows.length > 0) {
    deps.logger?.info(
      '[credential-pipeline-b2b] Active credential already exists for (firmId, userRef) — webhook redelivery, skipping',
      { ...logMeta, existingCredentialId: existingRows[0]!.id },
    );
    return;
  }

  // --- 2. Load Didit config + decision -----
  let diditConfig: DiditConfig;
  try {
    diditConfig = getDiditConfig();
  } catch (err) {
    deps.logger?.error('[credential-pipeline-b2b] Didit config not available', {
      ...logMeta,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Mirror the customer-flow `not_found` short-circuit: when the firm
  // deletes the underlying Didit session (operator cleanup, post-test
  // tidy, retention policy), Didit returns 404 forever. Without this
  // branch pg-boss retries 5× before giving up — same retry-spam +
  // wasted worker-cycle pattern as the customer flow. Recognise the
  // terminal state, mark the kyc_session row `expired`, audit, return
  // cleanly. All other DiditError codes re-throw so transient outages
  // / rotated credentials still get retried.
  const sessionId = asDiditSessionIdUnchecked(diditSessionId);
  let decision: Awaited<ReturnType<typeof getDecision>>;
  try {
    decision = await getDecision(diditConfig, sessionId);
  } catch (err) {
    if (isDiditErrorWithCode(err, 'not_found')) {
      const updated = await db
        .update(schema.kycSessions)
        .set({
          status: 'expired',
          failureReason: 'Verification session no longer recognised by provider.',
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.kycSessions.kind, 'b2b' as const),
            eq(schema.kycSessions.id, kycSessionId),
            inArray(schema.kycSessions.status, [...PULL_OVERWRITABLE_STATUSES]),
          ),
        )
        .returning({ id: schema.kycSessions.id });

      if (updated.length > 0) {
        await writeAudit(db, {
          action: 'kyc_session.expired',
          actor: systemActor('credential-pipeline'),
          target: uuidTarget({ kind: 'firm', id: firmId, ref: userRef }),
          context: EMPTY_CONTEXT,
          meta: {
            flow: 'b2b',
            kycSessionId,
            phase,
            diditSessionId,
            reason: 'pipeline_didit_session_deleted',
            diditErrorCode: 'not_found',
          },
          ts: now,
        });
        getRootLogger().info(
          {
            event: 'credential_pipeline_b2b_didit_session_deleted',
            kycSessionId,
            firmId,
            userRef,
            diditSessionId,
            phase,
          },
          '[credential-pipeline-b2b] Didit session deleted — marked kyc_session expired and exiting cleanly (no retry)',
        );
      } else {
        deps.logger?.info(
          '[credential-pipeline-b2b] Didit returned not_found but session already in terminal state — no-op',
          {
            ...logMeta,
            diditErrorCode: 'not_found',
          },
        );
      }
      return;
    }
    deps.logger?.error('[credential-pipeline-b2b] getDecision failed (transient) — re-throwing for pg-boss retry', {
      ...logMeta,
      error: err instanceof Error ? err.message : String(err),
      diditErrorCode: err instanceof Error && 'code' in err ? (err as { code?: string }).code : undefined,
    });
    throw err;
  }

  const flags = reduceDecision(decision);
  if (flags.outcome !== 'passed') {
    deps.logger?.info(
      '[credential-pipeline-b2b] Decision not passed, skipping mint',
      { ...logMeta, outcome: flags.outcome },
    );
    return;
  }

  // --- 3. Compute proof hash -----
  const proofHash = computeProofHash(diditConfig, decision);

  // --- 4. Resolve the on-chain subject address -----
  const fhe = getFheClient();
  const fheConfig = fhe.config;
  // B2B subjects are the firm's users (no Crivacy wallet), so the credential is
  // keyed by a deterministic custodial address derived from firmId:userRef —
  // the FHE analogue of the chain synthetic party.
  const userAddress = deriveB2bUserAddress(firmId, userRef);

  // B2B levels: phase 'identity' = 'basic'; phase 'address' = 'enhanced'.
  // No customers.kyc_level mapping because the firm holds the user's
  // record off-chain.
  const credentialLevel: 'basic' | 'enhanced' = phase === 'address' ? 'enhanced' : 'basic';
  const validUntil = new Date(now.getTime() + CREDENTIAL_VALIDITY_MS);

  // --- 5. Issue the encrypted credential on-chain (Zama FHEVM / Sepolia) ---
  // sanctioned=false by construction: only approved, fraud-screened decisions
  // reach this point (see the customer-flow note).
  const fheResult = await fhe.createCredential({
    userAddress,
    userRef,
    proofHash,
    level: credentialLevel,
    humanScore: flags.humanScore,
    identityVerified: flags.identityVerified,
    livenessVerified: flags.livenessVerified,
    addressVerified: flags.addressVerified,
    sanctioned: false,
    validator: 'didit',
    validUntil,
  });

  deps.logger?.info('[credential-pipeline-b2b] FHE credential created', {
    ...logMeta,
    userAddress: fheResult.userAddress,
    txHash: fheResult.txHash,
  });

  // --- 6. Cache the on-chain ciphertext handles -----
  let disclosureBlobCache: Uint8Array | null = null;
  let disclosureBlobFetchedAt: Date | null = null;
  try {
    const onchain = await fhe.fetchCredential(userAddress);
    if (onchain !== null) {
      disclosureBlobCache = Buffer.from(JSON.stringify(onchain.handles), 'utf8');
      disclosureBlobFetchedAt = now;
      deps.logger?.info('[credential-pipeline-b2b] Ciphertext handles cached', {
        ...logMeta,
        userAddress,
        blobBytes: disclosureBlobCache.length,
      });
    }
  } catch (blobErr) {
    deps.logger?.error('[credential-pipeline-b2b] Failed to fetch ciphertext handles', {
      ...logMeta,
      userAddress,
      error: blobErr instanceof Error ? blobErr.message : String(blobErr),
    });
  }

  // --- 7. Insert kyc_credentials_meta -----
  const { resolveProofSchemaId } = await import('@/lib/proof-schemas');
  const proofSchemaId = await resolveProofSchemaId(
    db,
    phase === 'identity' ? 'kyc' : 'address',
    'v1',
  );
  const { createCredential: insertCredentialMeta } = await import(
    '@/server/repositories/credentials'
  );

  let credentialMeta: Awaited<ReturnType<typeof insertCredentialMeta>>;
  try {
    // Legacy `chain_*` column names, FHE / EVM values (see customer-flow note).
    credentialMeta = await insertCredentialMeta(db, {
      firmId,
      userRef,
      kycSessionId,
      chainContractId: fheResult.txHash,
      chainPackageName: 'crivacy-fhe-v1',
      chainTemplateId: fheConfig.kycAddress,
      chainNetwork: fheConfig.networkLabel as 'mainnet' | 'devnet' | 'sepolia',
      operatorParty: fheConfig.operatorAddress,
      userParty: userAddress,
      level: credentialLevel,
      validator: 'didit',
      proofHash,
      proofSchemaId,
      humanScore: flags.humanScore,
      identityVerified: flags.identityVerified ? 1 : 0,
      livenessVerified: flags.livenessVerified ? 1 : 0,
      addressVerified: flags.addressVerified ? 1 : 0,
      validUntil,
      confirmedAt: now,
      disclosureBlobCache,
      disclosureBlobFetchedAt,
      chainSubmissionId: fheResult.txHash,
      chainUpdateId: fheResult.txHash,
    });
  } catch (insertErr) {
    const insertErrMsg = insertErr instanceof Error ? insertErr.message : String(insertErr);
    deps.logger?.error(
      '[credential-pipeline-b2b] DB insert failed after on-chain mint — running compensating revoke',
      { ...logMeta, userAddress, txHash: fheResult.txHash, error: insertErrMsg },
    );

    let compensatingRevokeStatus: 'succeeded' | 'failed' = 'failed';
    let compensatingRevokeError: string | undefined;
    try {
      await fhe.revokeCredential(userAddress, false);
      compensatingRevokeStatus = 'succeeded';
    } catch (revokeErr) {
      compensatingRevokeError = revokeErr instanceof Error ? revokeErr.message : String(revokeErr);
    }

    await writeAudit(db, {
      action: 'credential.chain_error',
      actor: systemActor('credential-pipeline'),
      target: uuidTarget({ kind: 'firm', id: firmId, ref: userRef }),
      context: EMPTY_CONTEXT,
      meta: {
        flow: 'b2b',
        operation: 'insert_credential_meta',
        userAddress,
        txHash: fheResult.txHash,
        insertError: insertErrMsg,
        compensatingRevoke: compensatingRevokeStatus,
        ...(compensatingRevokeError !== undefined
          ? { compensatingRevokeError }
          : {}),
        recovery:
          compensatingRevokeStatus === 'succeeded'
            ? 'chain_state_clean_pg_boss_will_retry'
            : 'orphan_record_requires_manual_revoke',
      },
      ts: now,
    });
    throw insertErr;
  }

  deps.logger?.info('[credential-pipeline-b2b] Credential meta stored', {
    ...logMeta,
    credentialMetaId: credentialMeta.id,
    txHash: fheResult.txHash,
  });

  // --- 8. Audit `credential.firm_issued` -----
  await writeAudit(db, {
    action: 'credential.firm_issued',
    actor: systemActor('credential-pipeline'),
    target: uuidTarget({
      kind: 'credential',
      id: credentialMeta.id,
      ref: fheResult.txHash,
    }),
    context: EMPTY_CONTEXT,
    meta: {
      flow: 'b2b',
      firmId,
      userRef,
      kycSessionId,
      phase,
      level: credentialLevel,
      txHash: fheResult.txHash,
    },
    ts: now,
  });

  // --- 9. Emit `kyc.session.approved` with the canonical credential view +
  //         session-extras (sessionId + workflow + approvedAt). The firm
  //         now receives the full credential snapshot — including the
  //         disclosure blob inline (base64url) — instead of the legacy
  //         metadata-only payload that pre-Sprint-5 callers received. -----
  try {
    const { emitFirmEvent } = await import('@/lib/webhook');
    const { fromKycCredentialMetaRow, toWebhookPayload } = await import(
      '@/lib/credentials/view'
    );
    const credentialPayload = toWebhookPayload(fromKycCredentialMetaRow(credentialMeta));
    await emitFirmEvent(db, {
      firmId,
      type: 'kyc.session.approved',
      payload: {
        ...credentialPayload,
        sessionId: kycSessionId,
        workflow: phase,
        approvedAt: now.toISOString(),
      },
      sourceSessionId: kycSessionId,
      idempotencyKey: `kyc.session.approved:${kycSessionId}`,
      now,
    });
    deps.logger?.info('[credential-pipeline-b2b] kyc.session.approved emitted', {
      ...logMeta,
      credentialMetaId: credentialMeta.id,
      txHash: fheResult.txHash,
    });
  } catch (webhookErr) {
    deps.logger?.error(
      '[credential-pipeline-b2b] kyc.session.approved emit failed — non-fatal',
      {
        ...logMeta,
        error: webhookErr instanceof Error ? webhookErr.message : String(webhookErr),
      },
    );
  }
}

/* ---------- Job enqueue helper ---------- */

/**
 * Enqueue a credential pipeline job. Called by the Didit webhook handler
 * and the resume session handler after an approval is detected.
 *
 * @param boss - pg-boss instance
 * @param job - Job payload
 * @returns pg-boss job ID (or null if deduplicated)
 */
export async function enqueueCredentialPipeline(
  boss: PgBoss,
  job: CredentialPipelineJob,
): Promise<string | null> {
  // The enqueuing process (Next server, short-lived pg-boss client) is
  // separate from the worker process, so it cannot rely on the worker
  // having created the queue first. pg-boss v10 `send()` to a missing
  // queue returns null and silently drops the job. createQueue is
  // idempotent, so ensure it exists on the sender side too.
  await boss.createQueue(CREDENTIAL_PIPELINE_QUEUE);
  return boss.send(CREDENTIAL_PIPELINE_QUEUE, job, {
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 30, // 30 seconds between retries
    expireInSeconds: 7200, // expire after 2 hours if not processed
    singletonKey: `${job.kycSessionId}:${job.phase}`, // deduplicate by session + phase
  });
}
