/**
 * Credential repository — data access for `kyc_credentials_meta`.
 *
 * @module
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { kycCredentialsMeta } from '@/lib/db/schema';
import type { KycCredentialMeta } from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Find the active (or most recent) credential for a `(firmId, userRef)`.
 * Returns the `active` credential if one exists, otherwise the most
 * recent `revoked` or `expired`.
 */
export async function findCredentialByUserRef(
  db: CrivacyDatabase,
  firmId: string,
  userRef: string,
): Promise<KycCredentialMeta | null> {
  // Try active first
  const activeRows = await db
    .select()
    .from(kycCredentialsMeta)
    .where(
      and(
        eq(kycCredentialsMeta.firmId, firmId),
        eq(kycCredentialsMeta.userRef, userRef),
        sql`${kycCredentialsMeta.status} in ('pending', 'active')`,
      ),
    )
    .orderBy(desc(kycCredentialsMeta.createdAt))
    .limit(1);

  if (activeRows[0] !== undefined) {
    return activeRows[0];
  }

  // Fallback to most recent of any status
  const allRows = await db
    .select()
    .from(kycCredentialsMeta)
    .where(and(eq(kycCredentialsMeta.firmId, firmId), eq(kycCredentialsMeta.userRef, userRef)))
    .orderBy(desc(kycCredentialsMeta.createdAt))
    .limit(1);

  return allRows[0] ?? null;
}

/**
 * Find a credential by chain contract ID.
 */
export async function findCredentialByContractId(
  db: CrivacyDatabase,
  firmId: string,
  contractId: string,
): Promise<KycCredentialMeta | null> {
  const rows = await db
    .select()
    .from(kycCredentialsMeta)
    .where(
      and(
        eq(kycCredentialsMeta.firmId, firmId),
        eq(kycCredentialsMeta.chainContractId, contractId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * List all credentials ever issued for a `(firmId, userRef)`, sorted by
 * creation date descending (newest first).
 */
export async function listCredentialHistory(
  db: CrivacyDatabase,
  firmId: string,
  userRef: string,
): Promise<readonly KycCredentialMeta[]> {
  return db
    .select()
    .from(kycCredentialsMeta)
    .where(and(eq(kycCredentialsMeta.firmId, firmId), eq(kycCredentialsMeta.userRef, userRef)))
    .orderBy(desc(kycCredentialsMeta.createdAt));
}

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------

export interface CreateCredentialInput {
  readonly firmId: string;
  readonly userRef: string;
  readonly kycSessionId: string | null;
  readonly chainContractId: string | null;
  readonly chainPackageName: string;
  readonly chainTemplateId: string;
  readonly chainNetwork: 'mainnet' | 'devnet' | 'sepolia';
  readonly operatorParty: string;
  readonly userParty: string;
  readonly level: 'basic' | 'enhanced';
  readonly validator: 'didit' | 'chain' | 'zk';
  readonly proofHash: string;
  /**
   * FK to `proof_schemas` row pinning the field set + canonical
   * algorithm used to compute `proofHash`. Resolved by the worker via
   * `lib/proof-schemas.ts::resolveProofSchemaId`. NEVER hard-code
   * a uuid here — always go through the resolver so a missing seed
   * row throws loudly instead of corrupting reproducibility.
   */
  readonly proofSchemaId: string;
  readonly humanScore: number;
  readonly identityVerified: number;
  readonly livenessVerified: number;
  readonly addressVerified: number;
  readonly validUntil: Date;
  readonly confirmedAt: Date | null;
  readonly disclosureBlobCache: Uint8Array | null;
  readonly disclosureBlobFetchedAt: Date | null;
  readonly chainSubmissionId: string | null;
  /**
   * chain update id (a.k.a. transaction id) returned by the
   * participant on a successful submit. Stored alongside the
   * contract id so admin / customer UIs can deep-link a credential
   * mint to its on-chain transaction page on Sepolia scan tools
   * (ccview.io, Splice scan). NULL when the row pre-dates the
   * column or for `pending` rows whose mint hasn't returned yet.
   */
  readonly chainUpdateId: string | null;
}

export async function createCredential(
  db: CrivacyDatabase,
  input: CreateCredentialInput,
): Promise<KycCredentialMeta> {
  const rows = await db
    .insert(kycCredentialsMeta)
    .values({
      firmId: input.firmId,
      userRef: input.userRef,
      kycSessionId: input.kycSessionId,
      chainContractId: input.chainContractId,
      chainPackageName: input.chainPackageName,
      chainTemplateId: input.chainTemplateId,
      chainNetwork: input.chainNetwork,
      operatorParty: input.operatorParty,
      userParty: input.userParty,
      level: input.level,
      status: input.chainContractId !== null ? 'active' : 'pending',
      validator: input.validator,
      proofHash: input.proofHash,
      proofSchemaId: input.proofSchemaId,
      humanScore: input.humanScore,
      identityVerified: input.identityVerified,
      livenessVerified: input.livenessVerified,
      addressVerified: input.addressVerified,
      validUntil: input.validUntil,
      confirmedAt: input.confirmedAt,
      disclosureBlobCache: input.disclosureBlobCache,
      disclosureBlobFetchedAt: input.disclosureBlobFetchedAt,
      chainSubmissionId: input.chainSubmissionId,
      chainUpdateId: input.chainUpdateId,
    })
    .returning();

  const row = rows[0];
  if (row === undefined) {
    throw new Error('Credential insert returned no rows.');
  }
  return row;
}

/**
 * Find credentials that have aged past their `valid_until` window
 * but are still in `status = 'active'`. Used by the
 * `credential-expire-worker` (PROD-TODO blocker #1) to drive the
 * TTL expiration pipeline: each row returned here gets flipped
 * to `expired` and a `credential.expired` webhook fires to the
 * issuing firm.
 *
 * Excludes rows that already have an `expired_at` stamp — those
 * have been processed by a previous sweep and are simply still
 * status='active' (expected during the window between the
 * worker's status flip and a cleanup that hasn't shipped yet).
 *
 * Returns at most `batchSize` rows ordered by oldest-`valid_until`
 * first so a backlog drains in age order.
 */
export async function findExpiredCredentialsToFlip(
  db: CrivacyDatabase,
  now: Date,
  batchSize: number,
): Promise<readonly KycCredentialMeta[]> {
  return db
    .select()
    .from(kycCredentialsMeta)
    .where(
      and(
        eq(kycCredentialsMeta.status, 'active'),
        sql`${kycCredentialsMeta.validUntil} <= ${now}`,
        sql`${kycCredentialsMeta.expiredAt} IS NULL`,
      ),
    )
    .orderBy(kycCredentialsMeta.validUntil)
    .limit(batchSize);
}

/**
 * Stamp the showcase NFT contract id + mint timestamp onto a credential
 * row. Called from the credential pipeline worker after `createKycNft`
 * succeeds — the credential already carries `status = active`, this
 * fills in the NFT cross-reference for the cascade-burn lookup that
 * happens at revoke time.
 */
export async function setCredentialNftMinted(
  db: CrivacyDatabase,
  credentialId: string,
  nftContractId: string,
  nftMintedAt: Date,
  nftChainUpdateId: string | null,
): Promise<void> {
  await db
    .update(kycCredentialsMeta)
    .set({
      nftContractId,
      nftMintedAt,
      nftChainUpdateId,
      updatedAt: new Date(),
    })
    .where(eq(kycCredentialsMeta.id, credentialId));
}

/**
 * Atomic CAS variant of {@link setCredentialNftMinted}. Stamps the NFT
 * cross-reference onto a credential row only if the row is still
 * `active`, `level = 'enhanced'`, and `nft_contract_id IS NULL`.
 * Returns `true` if the row was claimed by this call, `false` if a
 * concurrent caller (or revoke / level downgrade) already moved the
 * row out of the claimable state.
 *
 * Used by the user-triggered mint endpoint
 * (`POST /api/customer/credential/mint-nft`) where two parallel
 * requests on the same credential could each succeed at the chain
 * mint stage; the CAS here decides which UPDATE wins, leaving the
 * other caller with a 409 to surface to the user. The losing caller's
 * NFT is an orphan on chain (bound to the same credential id but not
 * referenced by the meta row); a future reconciler can detect orphans
 * by enumerating active KycNFT contracts whose `boundCredentialId`
 * does not match any `kyc_credentials_meta.nft_contract_id`.
 */
export async function claimCredentialNftMinted(
  db: CrivacyDatabase,
  credentialId: string,
  nftContractId: string,
  nftMintedAt: Date,
  nftChainUpdateId: string | null,
): Promise<boolean> {
  const result = await db
    .update(kycCredentialsMeta)
    .set({
      nftContractId,
      nftMintedAt,
      nftChainUpdateId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(kycCredentialsMeta.id, credentialId),
        eq(kycCredentialsMeta.status, 'active'),
        eq(kycCredentialsMeta.level, 'enhanced'),
        isNull(kycCredentialsMeta.nftContractId),
      ),
    )
    .returning({ id: kycCredentialsMeta.id });
  return result.length > 0;
}

/**
 * Stamp the NFT burn timestamp on a credential row. Called from the
 * credential pipeline worker after `revokeCredential` lands with the
 * cascade-burn cid — the same chain tx archived both contracts, so
 * the DB write here is just the off-chain mirror update.
 */
export async function setCredentialNftBurned(
  db: CrivacyDatabase,
  credentialId: string,
  nftBurnedAt: Date,
): Promise<void> {
  await db
    .update(kycCredentialsMeta)
    .set({
      nftBurnedAt,
      updatedAt: new Date(),
    })
    .where(eq(kycCredentialsMeta.id, credentialId));
}

export async function updateCredentialStatus(
  db: CrivacyDatabase,
  credentialId: string,
  status: KycCredentialMeta['status'],
  extra?: {
    chainContractId?: string;
    confirmedAt?: Date;
    revokedAt?: Date;
    revokedReason?: string;
    expiredAt?: Date;
    disclosureBlobCache?: Uint8Array;
    disclosureBlobFetchedAt?: Date;
  },
): Promise<KycCredentialMeta | null> {
  const rows = await db
    .update(kycCredentialsMeta)
    .set({
      status,
      updatedAt: new Date(),
      ...(extra?.chainContractId !== undefined
        ? { chainContractId: extra.chainContractId }
        : {}),
      ...(extra?.confirmedAt !== undefined ? { confirmedAt: extra.confirmedAt } : {}),
      ...(extra?.revokedAt !== undefined ? { revokedAt: extra.revokedAt } : {}),
      ...(extra?.revokedReason !== undefined ? { revokedReason: extra.revokedReason } : {}),
      ...(extra?.expiredAt !== undefined ? { expiredAt: extra.expiredAt } : {}),
      ...(extra?.disclosureBlobCache !== undefined
        ? { disclosureBlobCache: extra.disclosureBlobCache }
        : {}),
      ...(extra?.disclosureBlobFetchedAt !== undefined
        ? { disclosureBlobFetchedAt: extra.disclosureBlobFetchedAt }
        : {}),
    })
    .where(eq(kycCredentialsMeta.id, credentialId))
    .returning();

  return rows[0] ?? null;
}
