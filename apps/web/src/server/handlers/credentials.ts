/**
 * Credential handlers — business logic for `/api/v1/credentials`.
 *
 * @module
 */

import type { NextResponse } from 'next/server';

import type { KycCredentialMeta } from '@/lib/db/schema';
import {
  fromKycCredentialMetaRow,
  toRestDetail,
  toRestSummary,
} from '@/lib/credentials/view';
import { CredentialVerifyRequest } from '@/lib/openapi/schemas/credential';
import { z } from 'zod';
import type { AuthenticatedContext } from '../context';
import { parseBody, parsePathParams } from '../middleware/parse';
import { findCredentialByUserRef, listCredentialHistory } from '../repositories';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PathUserRefParams = z.object({
  userRef: z.string().min(1).max(256),
});

// REST projection helpers — `lib/credentials/view.ts` is the single source of
// truth for what a credential looks like on every wire surface (REST detail,
// REST summary, OAuth claims, webhook payloads). These thin wrappers exist so
// the handler reads cleanly while still routing through the canonical view.
function credentialToSummary(cred: KycCredentialMeta) {
  return toRestSummary(fromKycCredentialMetaRow(cred));
}

function credentialToDetail(cred: KycCredentialMeta) {
  return toRestDetail(fromKycCredentialMetaRow(cred));
}

function credentialToHistoryEntry(cred: KycCredentialMeta) {
  if (cred.revokedAt !== null) {
    return {
      at: cred.revokedAt.toISOString(),
      action: 'revoked' as const,
      actor: 'operator',
      transactionId: null,
      meta: { reason: cred.revokedReason },
    };
  }
  if (cred.expiredAt !== null) {
    return {
      at: cred.expiredAt.toISOString(),
      action: 'expired' as const,
      actor: 'chain',
      transactionId: null,
    };
  }
  return {
    at: cred.createdAt.toISOString(),
    action: 'created' as const,
    actor: 'operator',
    transactionId: cred.chainContractId,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/credentials/:userRef — read the active credential.
 */
export async function handleGetCredential(
  ctx: AuthenticatedContext,
  params: Promise<Record<string, string | string[]>>,
): Promise<NextResponse> {
  const { userRef } = await parsePathParams(params, PathUserRefParams);

  const cred = await findCredentialByUserRef(ctx.db, ctx.firm.id, userRef);
  if (cred === null) {
    return ctx.errorJson('not_found', `No credential found for userRef "${userRef}".`, 404);
  }

  if (cred.status === 'revoked') {
    return ctx.errorJson(
      'credential_revoked',
      `Credential for userRef "${userRef}" has been revoked.`,
      410,
    );
  }

  if (cred.status === 'expired') {
    return ctx.errorJson(
      'credential_expired',
      `Credential for userRef "${userRef}" has expired.`,
      410,
    );
  }

  return ctx.json(credentialToDetail(cred));
}

/**
 * POST /api/v1/credentials/verify — verify a credential on chain.
 *
 * Looks up the credential by the subject's EVM address (`userAddress`, the
 * on-chain key), reads its plaintext lifecycle straight from the `CrivacyKYC`
 * contract on Sepolia, and returns the verification result along with optional
 * constraint checks (`expectedUserRef`, `expectedLevel`, `expectedNetwork`).
 */
export async function handleVerifyCredential(ctx: AuthenticatedContext): Promise<NextResponse> {
  const body = await parseBody(ctx.request, CredentialVerifyRequest);

  // --- 1. Find the matching credential in the database ---
  // Strategy: if expectedUserRef is provided, look up by (firmId, userRef);
  // otherwise look up by the subject's EVM address (the on-chain key).
  let cred: KycCredentialMeta | null = null;

  if (body.expectedUserRef !== undefined) {
    cred = await findCredentialByUserRef(ctx.db, ctx.firm.id, body.expectedUserRef);
  }

  if (cred === null) {
    const { and: drizzleAnd, eq: drizzleEq, sql: drizzleSql } = await import('drizzle-orm');
    const { kycCredentialsMeta } = await import('@/lib/db/schema');

    const rows = await ctx.db
      .select()
      .from(kycCredentialsMeta)
      .where(
        drizzleAnd(
          drizzleEq(kycCredentialsMeta.firmId, ctx.firm.id),
          drizzleSql`lower(${kycCredentialsMeta.userParty}) = lower(${body.userAddress})`,
          drizzleSql`${kycCredentialsMeta.status} in ('active', 'pending')`,
        ),
      )
      .limit(1);

    cred = rows[0] ?? null;
  }

  if (cred === null) {
    return ctx.json({
      valid: false,
      reason: 'credential_not_found',
      credential: null,
      verifiedAt: ctx.now.toISOString(),
    });
  }

  // --- 3. Check terminal states before calling chain ---
  if (cred.status === 'revoked' || cred.status === 'superseded') {
    return ctx.json({
      valid: false,
      reason: 'revoked',
      credential: credentialToSummary(cred),
      verifiedAt: ctx.now.toISOString(),
    });
  }

  if (cred.status === 'expired') {
    return ctx.json({
      valid: false,
      reason: 'expired',
      credential: credentialToSummary(cred),
      verifiedAt: ctx.now.toISOString(),
    });
  }

  if (cred.chainContractId === null) {
    return ctx.json({
      valid: false,
      reason: 'pending_confirmation',
      credential: credentialToSummary(cred),
      verifiedAt: ctx.now.toISOString(),
    });
  }

  // --- 4. Validate expected constraints ---
  if (body.expectedLevel !== undefined && cred.level !== body.expectedLevel) {
    return ctx.json({
      valid: false,
      reason: 'level_mismatch',
      credential: credentialToSummary(cred),
      verifiedAt: ctx.now.toISOString(),
    });
  }

  if (body.expectedNetwork !== undefined && cred.chainNetwork !== body.expectedNetwork) {
    return ctx.json({
      valid: false,
      reason: 'network_mismatch',
      credential: credentialToSummary(cred),
      verifiedAt: ctx.now.toISOString(),
    });
  }

  if (body.expectedUserRef !== undefined && cred.userRef !== body.expectedUserRef) {
    return ctx.json({
      valid: false,
      reason: 'userRef_mismatch',
      credential: credentialToSummary(cred),
      verifiedAt: ctx.now.toISOString(),
    });
  }

  // --- 5. Confirm the credential on-chain (Zama FHEVM / Sepolia) ---
  const { getFheClient } = await import('@crivacy-fhe/credential');

  let fhe: ReturnType<typeof getFheClient>;
  try {
    fhe = getFheClient();
  } catch {
    return ctx.errorJson(
      'service_unavailable',
      'FHE client is not configured. Verification cannot be performed.',
      503,
    );
  }

  try {
    // The credential is keyed on the subject's EVM address (`userParty`). Read
    // its plaintext lifecycle straight from the chain — no decryption needed,
    // no Crivacy API trust: `status` / `isActive` are public on-chain fields.
    const userAddress = cred.userParty as `0x${string}`;
    const onchain = await fhe.fetchCredential(userAddress);

    if (onchain === null) {
      // No on-chain record — likely erased (GDPR) after the DB row was written.
      return ctx.json({
        valid: false,
        reason: 'contract_not_found_on_chain',
        credential: credentialToSummary(cred),
        verifiedAt: ctx.now.toISOString(),
      });
    }

    // The DB row is the trusted lifecycle source; the chain read confirms the
    // record exists and its on-chain active status agrees.
    const verified = cred.status === 'active' && onchain.isActive;

    // --- 6. Write audit log for verification ---
    const { writeAudit } = await import('@/lib/audit/writer');
    const { systemActor } = await import('@/lib/audit/actors');
    const { uuidTarget } = await import('@/lib/audit/targets');
    const { EMPTY_CONTEXT } = await import('@/lib/audit/context');

    await writeAudit(ctx.db, {
      action: 'credential.verified',
      actor: systemActor('api'),
      target: uuidTarget({ kind: 'credential', id: cred.id, ref: cred.chainContractId }),
      context: EMPTY_CONTEXT,
      meta: {
        firmId: ctx.firm.id,
        apiKeyId: ctx.apiKey.id,
        userAddress,
        verified,
        onChainStatus: onchain.status,
      },
      ts: ctx.now,
    });

    if (!verified) {
      return ctx.json({
        valid: false,
        reason: 'on_chain_verification_failed',
        credential: credentialToSummary(cred),
        verifiedAt: ctx.now.toISOString(),
      });
    }

    return ctx.json({
      valid: true,
      reason: null,
      credential: credentialToSummary(cred),
      verifiedAt: ctx.now.toISOString(),
    });
  } catch {
    // Unexpected on-chain read error — return 502
    return ctx.errorJson(
      'chain_error',
      'On-chain verification failed due to an upstream error.',
      502,
    );
  }
}

/**
 * GET /api/v1/credentials/:userRef/history — credential lifecycle history.
 */
export async function handleGetCredentialHistory(
  ctx: AuthenticatedContext,
  params: Promise<Record<string, string | string[]>>,
): Promise<NextResponse> {
  const { userRef } = await parsePathParams(params, PathUserRefParams);

  const credentials = await listCredentialHistory(ctx.db, ctx.firm.id, userRef);

  const entries = credentials.map(credentialToHistoryEntry);

  return ctx.json({
    userRef,
    entries,
    total: entries.length,
  });
}
