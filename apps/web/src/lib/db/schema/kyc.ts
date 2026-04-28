import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { apiKeys } from './api-keys';
import { customers } from './customers';
import {
  canonicalNetworkEnum,
  credentialStatusEnum,
  credentialValidatorEnum,
  kycLevelEnum,
  kycSessionKindEnum,
  kycSessionStatusEnum,
  kycSessionWorkflowEnum,
} from './enums';
import { firms } from './firms';

/**
 * `bytea` column alias — Drizzle ships `customType` for raw binary columns.
 * Used by `kyc_credentials_meta.disclosure_blob_cache` to store the
 * chain `createdEventBlob` that gets handed to firm participants during
 * Explicit Contract Disclosure.
 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  },
});

/**
 * `kyc_sessions` — one row per Didit verification attempt. Sprint 7
 * unified the prior split (B2B `kyc_sessions` + customer-flow
 * `customer_kyc_sessions`) into this single polymorphic-by-`kind`
 * table.
 *
 * Two flows coexist:
 *
 *   * `kind = 'b2b'`      — firm-issued via the public REST API. The
 *     row carries `firm_id`, `user_ref`, `created_by_api_key_id`,
 *     `level`. Joined to credential by `(firm_id, user_ref)`. Visible
 *     to the firm-scoped `crivacy_app` pool through the kind-aware
 *     RLS policy.
 *   * `kind = 'customer'` — self-service from `app.crivacy.io`. The
 *     row carries `customer_id` and the customer-specific
 *     `verification_url` / `resubmission_info`. Read/written through
 *     the admin pool (BYPASSRLS); RLS policy intentionally hides
 *     these rows from the firm-scoped pool.
 *
 * A CHECK constraint (`kyc_sessions_kind_invariant`) enforces that
 * kind-specific columns are populated for the matching `kind` and
 * NULL for the other. Kind-aware partial unique indexes
 * (`firm_user_workflow_active_key` for b2b, `customer_workflow_active_key`
 * for customer) enforce per-flow uniqueness without crossing.
 *
 * Two rows exist per end user when both phases are completed:
 *
 *   * `workflow = identity` → Didit phase 1 (ID + liveness + face match).
 *   * `workflow = address`  → Didit phase 2 (proof of address). Created
 *     lazily after phase 1 approves.
 *
 * `didit_session_id` is set after Didit's session API returns; until
 * then the row exists only to carry the Didit callback URL and
 * stateful expiry timer.
 *
 * Status mirrors the progress of the verification. The Didit webhook
 * handler advances the row through the enum; the credential-expire
 * worker stamps `expired` after `expires_at`.
 */
export const kycSessions = pgTable(
  'kyc_sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /**
     * Polymorphic discriminator (Sprint 7). Branches every consumer
     * (handlers, workers, repositories) when behavior differs between
     * B2B and customer flows. Always set; CHECK constraint enforces
     * kind-specific column presence/absence.
     *
     * **Phase F note (2026-05-09)**: TS nullability now matches DB. The
     * fields `firmId`, `userRef`, `createdByApiKeyId`, `level` are NULL
     * for `kind='customer'` rows (per the kind invariant CHECK
     * constraint). B2B read sites that need a non-null value either:
     *   - establish the kind via the lookup query (`WHERE kind='b2b'`)
     *     and use a `!` non-null assertion at the read, OR
     *   - call a narrowing helper that asserts the b2b columns.
     */
    kind: kycSessionKindEnum('kind').notNull(),
    firmId: uuid('firm_id').references(() => firms.id, { onDelete: 'cascade' }),
    userRef: varchar('user_ref', { length: 256 }),
    createdByApiKeyId: uuid('created_by_api_key_id').references(() => apiKeys.id, {
      onDelete: 'restrict',
    }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    workflow: kycSessionWorkflowEnum('workflow').notNull(),
    level: kycLevelEnum('level'),
    status: kycSessionStatusEnum('status').notNull().default('pending'),
    diditSessionId: varchar('didit_session_id', { length: 256 }),
    diditWorkflowId: varchar('didit_workflow_id', { length: 64 }).notNull(),
    diditDecisionPayload: jsonb('didit_decision_payload'),
    callbackUrl: text('callback_url'),
    returnUrl: text('return_url'),
    verificationUrl: text('verification_url'),
    resubmissionInfo: jsonb('resubmission_info'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    failureReason: varchar('failure_reason', { length: 256 }),
    attempts: smallint('attempts').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('kyc_sessions_didit_session_id_key')
      .on(table.diditSessionId)
      .where(sql`${table.diditSessionId} is not null`),
    // B2B partial unique — narrow active-status set; b2b never reaches
    // `in_review` or `resubmission_pending` today.
    uniqueIndex('kyc_sessions_firm_user_workflow_active_key')
      .on(table.firmId, table.userRef, table.workflow)
      .where(
        sql`${table.kind} = 'b2b' and ${table.status} in ('pending','in_progress','identity_approved','address_in_progress')`,
      ),
    // Customer partial unique — superset active-status set carried
    // verbatim from the legacy `customer_kyc_sessions` partial index.
    uniqueIndex('kyc_sessions_customer_workflow_active_key')
      .on(table.customerId, table.workflow)
      .where(
        sql`${table.kind} = 'customer' and ${table.status} in ('pending','in_progress','in_review','resubmission_pending','identity_approved','address_in_progress')`,
      ),
    index('kyc_sessions_firm_user_ref_idx').on(table.firmId, table.userRef),
    index('kyc_sessions_firm_status_idx').on(table.firmId, table.status, table.createdAt),
    index('kyc_sessions_customer_id_idx')
      .on(table.customerId)
      .where(sql`${table.kind} = 'customer'`),
    index('kyc_sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export type KycSession = typeof kycSessions.$inferSelect;
export type NewKycSession = typeof kycSessions.$inferInsert;

// ---------------------------------------------------------------------------
// kyc_device_handoffs
// ---------------------------------------------------------------------------

/**
 * `kyc_device_handoffs` — supports the multi-device KYC handoff flow. When a
 * customer starts KYC on desktop but needs to complete biometric checks on a
 * mobile device, a handoff row is created with a one-time token (stored as a
 * hash). The mobile device presents the raw token to resume the session.
 *
 * Security properties:
 *   - Only the SHA-256 hash of the token is stored; the raw token is never
 *     persisted.
 *   - `expires_at` enforces a tight TTL (typically 10 minutes).
 *   - `consumed_at` is stamped on first use; the token cannot be replayed.
 *   - `device_info` records the user-agent of the consuming device for audit.
 *
 * Cleanup of expired/consumed rows runs via pg-boss scheduled job.
 *
 * Sprint 7 Phase H — moved here from `customer-kyc.ts` when the legacy
 * `customer_kyc_sessions` table was dropped. The `session_id` FK now
 * targets the unified `kyc_sessions(id)` (FK retargeted in Phase G,
 * migration `20260509240000`).
 */
export const kycDeviceHandoffs = pgTable(
  'kyc_device_handoffs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => kycSessions.id, { onDelete: 'cascade' }),
    handoffTokenHash: text('handoff_token_hash').notNull(),
    deviceInfo: text('device_info'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('kyc_device_handoffs_token_hash_idx').on(table.handoffTokenHash),
    index('kyc_device_handoffs_session_consumed_idx').on(table.sessionId, table.consumedAt),
  ],
);

export type KycDeviceHandoff = typeof kycDeviceHandoffs.$inferSelect;
export type NewKycDeviceHandoff = typeof kycDeviceHandoffs.$inferInsert;

/**
 * `kyc_credentials_meta` — off-chain mirror of a `chain.VC.Credential`
 * contract on Sepolia MainNet. The row is created in `pending` state after
 * the on-chain submit is issued; the chain client
 * flips it to `active` once the transaction confirms and returns a
 * contract id.
 *
 * `chain_contract_id` is the authoritative identifier used for Explicit
 * Contract Disclosure flows; it is unique across the system. The cached
 * `disclosure_blob_cache` stores the `createdEventBlob` so repeat
 * disclosures to the same firm do not re-fetch from the validator.
 */
/**
 * `proof_schemas` — append-only registry of canonical hash schemas.
 *
 * Each row pins the field set + canonical algorithm used to compute
 * the `proof_hash` of a credential. `kyc_credentials_meta` rows
 * carry an FK to a row here, so every credential can be reproduced
 * years later from a single SQL JOIN even if application code evolves.
 *
 * **Append-only — Postgres trigger blocks UPDATE + DELETE.**
 * Modifying an existing spec is a compliance violation; if a spec
 * needs to change, INSERT a new row with a bumped `(chain, version)`
 * pair and have new credentials reference it. Old credentials keep
 * their FK to the original row, which stays byte-immutable forever.
 *
 * Seed rows + immutability triggers are created in migration
 * `20260509000000_pii_purge_and_proof_schemas.sql`. The companion
 * application module `lib/proof-schemas.ts` is the SOURCE for
 * inserting new spec rows on worker boot via `seedProofSchemas()`.
 */
export const proofSchemas = pgTable(
  'proof_schemas',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** `'kyc'` | `'address'` | `'kyc+address'` | future composite chains. */
    chain: text('chain').notNull(),
    /** Spec version — bump (`v1` → `v2`) instead of editing an existing row. */
    version: text('version').notNull(),
    /**
     * Canonical-sorted (lexicographic ASCII) field name array. Auditor
     * reads this verbatim as the input keyset for `canonicalJson`. May
     * be a flat array (single-workflow specs) or a nested object keyed
     * by sub-document (composite specs — see `kyc+address-v1`).
     */
    fieldsInOrder: jsonb('fields_in_order').notNull(),
    /** Algorithm identifier, e.g. `'sortKeys+shortenFloats+sha256'`. */
    canonicalAlgo: text('canonical_algo').notNull(),
    /** Auditor docs anchor, e.g. `'/docs/proof-hash-schema#kyc-v1'`. */
    sourceDocUrl: text('source_doc_url'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('proof_schemas_chain_version_key').on(table.chain, table.version),
    index('proof_schemas_chain_version_idx').on(table.chain, table.version),
  ],
);

export type ProofSchema = typeof proofSchemas.$inferSelect;
export type NewProofSchema = typeof proofSchemas.$inferInsert;

export const kycCredentialsMeta = pgTable(
  'kyc_credentials_meta',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    firmId: uuid('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    userRef: varchar('user_ref', { length: 256 }).notNull(),
    kycSessionId: uuid('kyc_session_id').references(() => kycSessions.id, {
      onDelete: 'set null',
    }),
    chainContractId: text('chain_contract_id'),
    chainPackageName: varchar('chain_package_name', { length: 128 }).notNull(),
    chainTemplateId: varchar('chain_template_id', { length: 256 }).notNull(),
    chainNetwork: canonicalNetworkEnum('chain_network').notNull(),
    operatorParty: text('operator_party').notNull(),
    userParty: text('user_party').notNull(),
    level: kycLevelEnum('level').notNull(),
    status: credentialStatusEnum('status').notNull().default('pending'),
    validator: credentialValidatorEnum('validator').notNull(),
    proofHash: varchar('proof_hash', { length: 128 }).notNull(),
    /**
     * FK to `proof_schemas` — pins the field set + canonical algorithm
     * used to compute `proof_hash`. JOIN to read the spec at audit time.
     * NOT NULL since migration `20260509000000_pii_purge_and_proof_schemas.sql`
     * (every existing row was backfilled before the constraint flip).
     */
    proofSchemaId: uuid('proof_schema_id')
      .notNull()
      .references(() => proofSchemas.id),
    humanScore: smallint('human_score').notNull().default(0),
    identityVerified: integer('identity_verified').notNull().default(0),
    livenessVerified: integer('liveness_verified').notNull().default(0),
    addressVerified: integer('address_verified').notNull().default(0),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    validUntil: timestamp('valid_until', { withTimezone: true, mode: 'date' }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: varchar('revoked_reason', { length: 256 }),
    expiredAt: timestamp('expired_at', { withTimezone: true, mode: 'date' }),
    disclosureBlobCache: bytea('disclosure_blob_cache'),
    disclosureBlobFetchedAt: timestamp('disclosure_blob_fetched_at', {
      withTimezone: true,
      mode: 'date',
    }),
    /**
     * When a customer completes phase 2 (address verification), the phase 1
     * credential is superseded: its status changes to `superseded` and this
     * column points to the replacement credential issued at a higher level.
     * Self-referencing FK; NULL for credentials that have not been superseded.
     */
    supersededBy: uuid('superseded_by'),
    // chain command id (`crv-{op}-{ts}-{rand}`) — not a UUID. The
    // command builder caps at 128 chars; the column matches.
    chainSubmissionId: varchar('chain_submission_id', { length: 128 }),
    // On-chain transaction hash (`0x` + 64 hex) for the credential
    // write on the `CrivacyKYC` contract. Used to deep-link a credential
    // mint/revoke to its transaction on Etherscan (`/tx/<hash>`). NULL on
    // rows written before the column existed.
    chainUpdateId: varchar('chain_update_id', { length: 256 }),
    // Soulbound showcase NFT (`CrivacyKycNFT` companion contract).
    // Minted only for Enhanced-level credentials; NULL for Basic.
    // Burned atomically in the same transaction as `revokeCredential`
    // when called with `burnNft = true`.
    nftContractId: varchar('nft_contract_id', { length: 8192 }),
    nftMintedAt: timestamp('nft_minted_at', { withTimezone: true, mode: 'date' }),
    nftBurnedAt: timestamp('nft_burned_at', { withTimezone: true, mode: 'date' }),
    // chain update id of the NFT mint submit. Distinct from
    // `chainUpdateId` (which is the credential mint) because the NFT
    // mint is a separate chain tx triggered later by the customer.
    // Same `1220<hex>:<n>` shape; same role — deep-link to the NFT's
    // on-chain mint event in chain scan tools.
    nftChainUpdateId: varchar('nft_chain_update_id', { length: 256 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('kyc_credentials_meta_contract_id_key')
      .on(table.chainContractId)
      .where(sql`${table.chainContractId} is not null`),
    uniqueIndex('kyc_credentials_meta_firm_user_active_key')
      .on(table.firmId, table.userRef)
      .where(sql`${table.status} in ('pending','active')`),
    index('kyc_credentials_meta_firm_user_idx').on(table.firmId, table.userRef),
    index('kyc_credentials_meta_valid_until_idx').on(table.validUntil),
    index('kyc_credentials_meta_status_idx').on(table.status, table.validUntil),
    index('kyc_credentials_meta_nft_contract_id_idx')
      .on(table.nftContractId)
      .where(sql`${table.nftContractId} is not null`),
    index('kyc_credentials_meta_nft_chain_update_id_idx')
      .on(table.nftChainUpdateId)
      .where(sql`${table.nftChainUpdateId} is not null`),
    index('kyc_credentials_meta_nft_pending_remint_idx')
      .on(table.id)
      .where(sql`${table.chainContractId} is not null
        and ${table.level} = 'enhanced'
        and ${table.nftContractId} is null
        and ${table.status} in ('pending','active')`),
    index('kyc_credentials_meta_proof_schema_id_idx').on(table.proofSchemaId),
  ],
);

export type KycCredentialMeta = typeof kycCredentialsMeta.$inferSelect;
export type NewKycCredentialMeta = typeof kycCredentialsMeta.$inferInsert;
