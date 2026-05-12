/**
 * EVM wallet login — Sign-In With Ethereum (EIP-4361 / SIWE).
 *
 * Replaces the legacy Ed25519 wallet login (formerly chain Console Wallet). A user's credential is
 * keyed on their EVM address, so linking that address — by proving control of
 * it with a signed SIWE message — is the on-ramp to a user-owned credential.
 *
 *   1. Server issues a signed challenge JWT carrying a random nonce.
 *   2. Frontend connects the wallet, builds an EIP-4361 message with the nonce
 *      + address + domain, and asks the wallet to sign it.
 *   3. Server verifies the JWT (nonce fresh, unexpired), verifies the SIWE
 *      signature (EIP-191 for EOAs, EIP-1271 for smart wallets) against a
 *      Sepolia client, and recovers the address.
 *   4. On success, creates or links a customer account under `evm_wallet`.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { createPublicClient, getAddress, http, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import { generateSiweNonce, parseSiweMessage, verifySiweMessage } from 'viem/siwe';

import { safeJwtVerify } from '@/lib/auth/jwt';
import type { CrivacyDatabase } from '@/lib/db/client';
import { EVM_WALLET_PROVIDER } from '@/lib/fhe/customer-address';
import { getRootLogger } from '@/lib/observability/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WalletProvider = typeof EVM_WALLET_PROVIDER; // 'evm_wallet'

export interface WalletUserInfo {
  /** The checksummed EVM address — the on-chain credential key. */
  readonly walletId: string;
  readonly provider: WalletProvider;
  /** Display name: a truncated address (`0x1234…abcd`). */
  readonly displayName: string;
  /** Email — always null for wallet-only users (EVM wallets carry no email). */
  readonly email: string | null;
  readonly address: Address;
}

// ---------------------------------------------------------------------------
// Challenge management (nonce + replay protection)
// ---------------------------------------------------------------------------

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes
const NONCE_CLEANUP_BUFFER_SECONDS = 60;

/**
 * Generate a challenge for SIWE. Unlike the chain flow, the message itself is
 * assembled on the frontend (it must carry the connected address); the server
 * only mints the nonce (wrapped in a signed JWT for stateless replay checks).
 */
export async function generateWalletChallenge(
  jwtSecret: string,
): Promise<{ challengeJwt: string; nonce: string }> {
  // EIP-4361 requires an alphanumeric nonce of length >= 8.
  const nonce = generateSiweNonce();
  const secret = new TextEncoder().encode(jwtSecret);

  const challengeJwt = await new SignJWT({ purpose: 'wallet_challenge', nonce })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${CHALLENGE_TTL_SECONDS}s`)
    .sign(secret);

  return { challengeJwt, nonce };
}

/**
 * Atomically mark a challenge nonce as used. Returns `true` on first use
 * (proceed), `false` on replay (reject). The `(nonce)` primary key gives the
 * atomic guarantee under concurrent verifies.
 */
export async function claimWalletNonce(
  db: CrivacyDatabase,
  nonce: string,
  now: Date = new Date(),
): Promise<boolean> {
  const expiresAt = new Date(
    now.getTime() + (CHALLENGE_TTL_SECONDS + NONCE_CLEANUP_BUFFER_SECONDS) * 1000,
  );
  const result = await db.execute<{ nonce: string }>(
    sql`INSERT INTO wallet_nonces_used (nonce, used_at, expires_at)
        VALUES (${nonce}, ${now.toISOString()}, ${expiresAt.toISOString()})
        ON CONFLICT (nonce) DO NOTHING
        RETURNING nonce`,
  );
  return result.rows.length > 0;
}

/** Verify the challenge JWT and extract the nonce it carries. */
export async function verifyWalletChallenge(
  challengeJwt: string,
  jwtSecret: string,
): Promise<string> {
  const secret = new TextEncoder().encode(jwtSecret);
  const { payload } = await safeJwtVerify(challengeJwt, secret);

  if (payload['purpose'] !== 'wallet_challenge') {
    throw new Error('Invalid challenge: wrong purpose');
  }
  const nonce = payload['nonce'];
  if (typeof nonce !== 'string') {
    throw new Error('Invalid challenge: missing nonce');
  }
  return nonce;
}

// ---------------------------------------------------------------------------
// SIWE signature verification
// ---------------------------------------------------------------------------

/**
 * Verify an EIP-4361 (SIWE) message + signature. Confirms the message carries
 * the expected nonce and that the signature is valid for the address named in
 * the message (EIP-191 recovery for EOAs, EIP-1271 for smart-contract wallets,
 * checked against a Sepolia client). Returns the checksummed address on success,
 * `null` on any failure.
 */
export async function verifyEvmWalletSignature(params: {
  readonly message: string;
  readonly signature: `0x${string}`;
  readonly expectedNonce: string;
}): Promise<Address | null> {
  let address: Address | undefined;
  try {
    const parsed = parseSiweMessage(params.message);
    address = parsed.address;
    if (address === undefined || parsed.nonce !== params.expectedNonce) {
      return null;
    }
  } catch {
    return null;
  }

  const rpcUrl = process.env['SEPOLIA_RPC_URL'];
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });

  try {
    const valid = await verifySiweMessage(client, {
      message: params.message,
      signature: params.signature,
      nonce: params.expectedNonce,
    });
    if (!valid) return null;
  } catch (err) {
    getRootLogger().debug(
      {
        event: 'siwe_verify_error',
        err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      },
      'SIWE verification error',
    );
    return null;
  }

  return getAddress(address);
}
