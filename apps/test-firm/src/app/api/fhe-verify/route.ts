/**
 * POST /api/fhe-verify — honest on-chain disclosure verify.
 *
 * Mirrors what a real third-party firm consuming Crivacy credentials
 * writes against `@crivacy/js-sdk`:
 *
 *   1. Pull the userinfo claims for this firm user (already stored
 *      after the OAuth code exchange via `/api/oauth-finish`).
 *   2. Hand the claims to `verifyDisclosure()`, which follows the
 *      `fhe_kyc_user_address` pointer, reads the `CrivacyKYC` contract
 *      on Sepolia over a plain viem RPC call, and returns the on-chain
 *      `CredentialView` struct — the plaintext lifecycle (userRefHash,
 *      proofHash, status, validator, validUntil, issuedAt) plus the
 *      encrypted `euint`/`ebool` handles.
 *   3. Cross-check `view.userRefHash === keccak256(claims.sub)` so a
 *      credential lifted from a different user's OAuth flow is rejected
 *      even though it reads back as authentic on chain.
 *
 * The route uses the SDK helper rather than hand-rolling Sepolia RPC
 * calls — that's the whole point of shipping the SDK to firms. Nothing
 * here trusts Crivacy: the firm reads the credential straight from the
 * contract. The sensitive fields stay encrypted as FHE ciphertext
 * handles on chain; a firm granted per-firm ACL (via Crivacy's
 * `grantAccess`) decrypts only the boolean eligibility verdict with the
 * Zama relayer. This route surfaces the plaintext lifecycle + the
 * handles for reference.
 *
 * Demo asterisk: in production a firm points its viem client at its own
 * Sepolia RPC endpoint and the `FHE_KYC_ADDRESS` of the deployed
 * registry. The code path (pointer → contract read → view) is
 * production-identical; only the RPC URL differs.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { keccak256, toBytes } from 'viem';

import {
  isCrivacyOauthError,
  verifyDisclosure,
  type CrivacyClaims,
} from '@crivacy/js-sdk';
import { decryptFirmEligibility, type FirmEligibilityResult } from '@crivacy-fhe/credential';
import { isAddress, type Address, type Hex } from 'viem';

import { listOauthIdentitiesForUser } from '../../data-store';
import { TF_SESSION_COOKIE } from '../../session';
import { findUserBySession } from '../../user-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Auth gate — caller must be a logged-in test-firm user. Without
  // it we have no claims to verify (the claims live on the stored
  // OAuth identity row, scoped per firm user).
  const tfToken = request.cookies.get(TF_SESSION_COOKIE)?.value ?? null;
  const tfUser = findUserBySession(tfToken);
  if (tfUser === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const identities = listOauthIdentitiesForUser(tfUser.id);
  const identity = identities[0] ?? null;
  if (identity === null) {
    return NextResponse.json(
      {
        error: 'no_crivacy_link',
        message: 'Link a Crivacy identity before running an on-chain check.',
      },
      { status: 409 },
    );
  }

  // The stored `claims` blob matches the OIDC userinfo wire shape
  // exactly. The test-firm data store types `credential_level` loosely
  // as `string` because it's a generic JSON store; Crivacy's server
  // only ever emits `'basic'` or `'enhanced'`, so the cast to the
  // SDK's stricter `CrivacyClaims` is safe at this boundary.
  const claims = identity.claims as CrivacyClaims;

  // In production the firm builds its own viem client pointed at Sepolia; the
  // demo reads Crivacy's public RPC + the CrivacyKYC registry address from env.
  const rpcUrl = process.env['SEPOLIA_RPC_URL'];
  const kycAddress = process.env['FHE_KYC_ADDRESS'] as `0x${string}` | undefined;

  let view: Awaited<ReturnType<typeof verifyDisclosure>>;
  try {
    view = await verifyDisclosure(claims, { rpcUrl, kycAddress });
  } catch (err: unknown) {
    if (isCrivacyOauthError(err)) {
      // Missing-pointer path — the userinfo response didn't carry the
      // `fhe_kyc_user_address` field. Surface the SDK's code for the UI.
      return NextResponse.json({ error: err.code, message: err.message }, { status: 409 });
    }
    return NextResponse.json(
      {
        error: 'chain_verify_failed',
        message: err instanceof Error ? err.message : 'Unknown verify failure.',
      },
      { status: 502 },
    );
  }

  // Subject-binding cross-check. A chain read succeeds for any address the firm
  // holds — including one lifted from another user's OAuth flow. The credential
  // carries `userRefHash = keccak256(userRef)`; comparing it against
  // keccak256(claims.sub) shuts that vector: a credential bound to a different
  // sub cannot satisfy this firm user's session.
  const expectedSub = typeof claims.sub === 'string' ? claims.sub : null;
  if (expectedSub === null) {
    return NextResponse.json(
      {
        error: 'sub_claim_missing',
        message:
          'OAuth response is missing the `sub` claim. Request the `openid` scope on authorize.',
      },
      { status: 409 },
    );
  }
  const expectedHash = keccak256(toBytes(expectedSub));
  if (view.userRefHash.toLowerCase() !== expectedHash.toLowerCase()) {
    return NextResponse.json(
      {
        error: 'user_ref_mismatch',
        message:
          'Credential is authentic on chain but bound to a different user — reject the session.',
        observedUserRefHash: view.userRefHash,
        expectedSub,
      },
      { status: 409 },
    );
  }

  // --- FHE eligibility decrypt (the real gatekeeper payoff) -------------
  //
  // The firm decrypts ONLY the boolean `eligible` verdict for this user,
  // signing with its OWN key (FIRM_EVM_PRIVATE_KEY) against the Zama relayer.
  // The grant landed on chain when the user consented (operator ran
  // `grantAccess`). If it hasn't yet, the firm-scoped handle is the zero
  // handle → `pending`; the firm retries. Fully degraded-graceful: any
  // decrypt error surfaces as `unavailable`, never a 500 — the plaintext
  // lifecycle above is already the honest baseline verdict.
  const eligibility = await computeFirmEligibility(
    claims.fhe_kyc_user_address,
    rpcUrl,
    kycAddress,
  );

  // Surface the plaintext lifecycle the firm read straight from chain plus
  // the decrypted eligibility verdict (or its pending/unavailable state).
  return NextResponse.json({
    verified: true,
    observedAt: new Date().toISOString(),
    userAddress: claims.fhe_kyc_user_address ?? null,
    contract: kycAddress ?? claims.fhe_kyc_contract ?? null,
    network: typeof claims.credential_network === 'string' ? claims.credential_network : 'sepolia',
    view: {
      userRefHash: view.userRefHash,
      proofHash: view.proofHash,
      status: view.status,
      validator: view.validator,
      validUntil: view.validUntil.toISOString(),
      issuedAt: view.issuedAt.toISOString(),
      isActive: view.isActive,
      encryptedHandles: view.handles,
    },
    eligibility,
    message:
      'Credential read directly from the CrivacyKYC contract on Sepolia. Crivacy is not in the trust loop for this verification.',
  });
}

/** Eligibility verdict surfaced to the firm UI. */
type EligibilityOutcome =
  | FirmEligibilityResult
  | { readonly status: 'unconfigured' }
  | { readonly status: 'unavailable' };

/**
 * Decrypt the firm-scoped `eligible` verdict with the firm's own key. Returns
 * a coarse status the UI can render without ever throwing into the route.
 */
async function computeFirmEligibility(
  userAddressRaw: string | undefined,
  rpcUrl: string | undefined,
  kycAddress: Address | undefined,
): Promise<EligibilityOutcome> {
  const firmKey = process.env['FIRM_EVM_PRIVATE_KEY'];
  if (
    firmKey === undefined ||
    !/^0x[0-9a-fA-F]{64}$/.test(firmKey) ||
    rpcUrl === undefined ||
    kycAddress === undefined ||
    userAddressRaw === undefined ||
    !isAddress(userAddressRaw)
  ) {
    // Firm hasn't configured its wallet key (or the credential carries no
    // on-chain address) — the FHE verdict simply isn't wired for this firm.
    return { status: 'unconfigured' };
  }

  try {
    return await decryptFirmEligibility({
      rpcUrl,
      kycAddress,
      firmPrivateKey: firmKey as Hex,
      userAddress: userAddressRaw,
    });
  } catch {
    // Relayer hiccup / ACL race — never fail the whole verify on it.
    return { status: 'unavailable' };
  }
}
