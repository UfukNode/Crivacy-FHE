/**
 * Resolve a customer's EVM wallet address — the on-chain identity a Crivacy
 * KYC credential is keyed by.
 *
 * In the chain model the "user party" was a synthetic id derived from the
 * customer UUID (custodial: only the operator could act for it). Under FHE the
 * credential is user-owned: it is keyed by the customer's own EVM wallet
 * address, which they prove control of via SIWE (EIP-4361) at link time. The
 * address lives in `customer_linked_accounts` under the `evm_wallet` provider,
 * with `provider_account_id` holding the checksummed address.
 *
 * @module
 */

import { and, eq } from 'drizzle-orm';
import { getAddress, isAddress, keccak256, toBytes, type Address } from 'viem';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';

/** Provider key for an EVM wallet link (SIWE). Single source of truth. */
export const EVM_WALLET_PROVIDER = 'evm_wallet' as const;

/**
 * Deterministic custodial address for a B2B credential subject.
 *
 * In the B2B flow the subject is the FIRM's user (identified by the firm's
 * `userRef`), not a Crivacy account holder — they have no wallet of their own,
 * exactly as the chain model used a synthetic party derived from
 * `firmId:userRef`. We mirror that here: the credential is keyed by a
 * deterministic address `keccak256(firmId:userRef)[12:]`. No private key exists
 * for it (and none is needed): the operator issues the credential and holds
 * decryption ACL, and relying firms decrypt via per-firm grants. The
 * self-decrypt path simply goes unused for B2B subjects.
 */
export function deriveB2bUserAddress(firmId: string, userRef: string): Address {
  const hash = keccak256(toBytes(`${firmId}:${userRef}`));
  // Take the last 20 bytes (40 hex chars) as the address, checksummed.
  return getAddress(`0x${hash.slice(-40)}`);
}

/**
 * Return the customer's linked EVM wallet address, or `null` if they have not
 * linked one yet. A credential cannot be issued to a customer without a linked
 * wallet — the caller must surface a "connect wallet" step rather than fall
 * back to a derived/custodial address.
 */
export async function getCustomerWalletAddress(
  db: CrivacyDatabase,
  customerId: string,
): Promise<Address | null> {
  const rows = await db
    .select({ providerAccountId: schema.customerLinkedAccounts.providerAccountId })
    .from(schema.customerLinkedAccounts)
    .where(
      and(
        eq(schema.customerLinkedAccounts.customerId, customerId),
        eq(schema.customerLinkedAccounts.provider, EVM_WALLET_PROVIDER),
      ),
    )
    .limit(1);

  const raw = rows[0]?.providerAccountId;
  if (raw === undefined || !isAddress(raw)) {
    return null;
  }
  // Normalize to the checksummed form so on-chain keying is canonical.
  return getAddress(raw);
}

/**
 * Like {@link getCustomerWalletAddress} but throws when absent — for call
 * sites (the credential pipeline) where a missing wallet is a hard error, not
 * a recoverable state.
 */
export async function requireCustomerWalletAddress(
  db: CrivacyDatabase,
  customerId: string,
): Promise<Address> {
  const address = await getCustomerWalletAddress(db, customerId);
  if (address === null) {
    throw new Error(
      `[fhe] customer ${customerId} has no linked EVM wallet — cannot issue a ` +
        `user-owned credential. The customer must link a wallet (SIWE) first.`,
    );
  }
  return address;
}
