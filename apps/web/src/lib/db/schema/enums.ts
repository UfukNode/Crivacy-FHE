import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * All Postgres enums are declared once here so schema files can import them
 * without circular graphs. Every value set below is kept in lock-step with
 * `@crivacy/shared-types`; adding or removing a value requires updating both
 * the shared type and the tests in `tests/db/schema.test.ts`.
 *
 * Two kinds of categorical fields exist in the schema:
 *
 *  1. **Finite, ordered, part of the product contract** — modeled as
 *     `pgEnum`. Changing a value requires a migration and a shared-types bump.
 *
 *  2. **Open-ended (scopes, webhook event types)** — stored as `text[]`
 *     because Postgres enums cannot contain `:` or `.`. Validation happens at
 *     the API boundary via Zod against the shared-types union.
 */

// ---------- Firm + billing ----------

export const firmTierEnum = pgEnum('firm_tier', ['free', 'starter', 'pro', 'enterprise']);

// ---------- API keys + sessions ----------

export const apiKeyModeEnum = pgEnum('api_key_mode', ['live', 'test']);

export const sessionKindEnum = pgEnum('session_kind', ['firm', 'admin', 'customer']);

// ---------- Customer ----------

export const customerStatusEnum = pgEnum('customer_status', [
  'pending_verification',
  'active',
  'suspended',
  'locked',
  'banned',
]);

export const customerKycLevelEnum = pgEnum('customer_kyc_level', [
  'kyc_0',
  'kyc_1',
  'kyc_2',
  'kyc_3',
  'kyc_4',
]);

// ---------- Users + roles ----------

export const firmUserRoleEnum = pgEnum('firm_user_role', ['owner', 'admin', 'member', 'viewer']);

export const adminUserRoleEnum = pgEnum('admin_user_role', ['superadmin', 'admin', 'support']);

// ---------- RBAC ----------

export const permissionDomainEnum = pgEnum('permission_domain', [
  'auth',
  'kyc',
  'credential',
  'ticket',
  'webhook',
  'firm',
  'admin',
  'system',
  // Added in migration 20260423160000_rbac_permission_domain_expand.sql
  // to support granular RBAC catalogue (api keys, OAuth clients, audit,
  // playground, profile, usage, notifications as first-class domains).
  'api_key',
  'oauth_client',
  'audit',
  'playground',
  'profile',
  'usage',
  'notifications',
]);

export const roleUserTypeEnum = pgEnum('role_user_type', [
  'customer',
  'firm_user',
  'admin_user',
]);

// ---------- KYC ----------

// Two-tier level vocabulary: `basic` = identity + liveness only,
// `enhanced` = identity + liveness + proof-of-address. Emitted on-chain
// under the `io.crivacy/level` claim key inside the
// `chain.VC.Credential` template's `claims.values` TextMap. The
// `standard` tier was removed in migration
// 20260430000000_kyc_level_drop_standard.sql.
export const kycLevelEnum = pgEnum('kyc_level', ['basic', 'enhanced']);

/**
 * Mirrors `KycStatus` in `@crivacy/shared-types`. `identity_approved` and
 * `address_in_progress` represent the two-phase Didit workflow (see
 * MEMORY.md → Didit Integration). `approved` is the terminal success state
 * after both phases complete.
 *
 * Didit-driven non-default states:
 *
 *   * `in_review` — Didit's "In Review" (compliance team flagged
 *     warnings, manual review pending). Different from `in_progress`
 *     (user is actively completing steps). Customer UI shows a
 *     review banner; restart endpoint refuses to mint a fresh session
 *     while a review is open.
 *
 *   * `resubmission_pending` — Didit's "Resubmitted" (compliance asked
 *     the user to redo specific steps). The same Didit session resumes
 *     from its original URL; the user only repeats the flagged
 *     features. Customer UI shows the list of nodes to redo + a
 *     "Resume verification" CTA.
 *
 *   * `kyc_expired` — Didit's "Kyc Expired" (a previously-approved
 *     verification crossed the expiration policy threshold). Triggers
 *     credential revoke on Sepolia, `kyc_level` reset to `kyc_0`, and
 *     a `credential.revoked` event fan-out to firms with active
 *     grants. Distinct from `expired` (which represents a session
 *     that timed out before reaching a verdict).
 */
export const kycSessionStatusEnum = pgEnum('kyc_session_status', [
  'pending',
  'in_progress',
  'in_review',
  'identity_approved',
  'address_in_progress',
  'approved',
  'rejected',
  'expired',
  'revoked',
  'resubmission_pending',
  'kyc_expired',
]);

/**
 * Which Didit workflow a session targets. `identity` = phase 1 (ID doc,
 * liveness, face match). `address` = phase 2 (proof of address). Each KYC
 * session row owns exactly one workflow; a firm issuing both phases for the
 * same end user creates two rows linked by `user_ref`.
 */
export const kycSessionWorkflowEnum = pgEnum('kyc_session_workflow', ['identity', 'address']);

/**
 * Sprint 7 — `kyc_sessions.kind` discriminator. The unified
 * `kyc_sessions` table hosts BOTH B2B (firm-issued) and customer
 * (self-service) flows; `kind` is the row-level switch consumers
 * branch on when behavior actually differs.
 *
 * Naming guard: this is **not** the same as the `session_kind`
 * enum used by the auth `sessions` table (firm/admin/customer login
 * sessions). Two distinct enums for two distinct domains — do not
 * conflate.
 */
export const kycSessionKindEnum = pgEnum('kyc_session_kind', ['customer', 'b2b']);

// ---------- Fraud ----------

export const fraudReasonEnum = pgEnum('fraud_reason', [
  'fraud_document',
  'fraud_identity',
  'fraud_liveness',
  'fraud_combined',
  'manual_ban',
]);

// ---------- Credentials ----------

export const credentialStatusEnum = pgEnum('credential_status', [
  'pending',
  'active',
  'revoked',
  'expired',
  'superseded',
]);

/**
 * Issuer-side validator vocabulary, emitted on-chain under the
 * `io.crivacy/validator` claim key inside the `chain.VC.Credential`
 * template's `claims.values` TextMap. The on-chain contract treats the
 * value as opaque text; new validators only require adding the
 * string here and the matching shared-types bump.
 */
export const credentialValidatorEnum = pgEnum('credential_validator', ['didit', 'chain', 'zk']);

// 'sepolia' added for the FHE (Zama FHEVM) on-chain layer that replaced chain.
// Requires an `ALTER TYPE canonical_network ADD VALUE 'sepolia'` migration.
export const canonicalNetworkEnum = pgEnum('canonical_network', ['mainnet', 'devnet', 'sepolia']);

// ---------- Webhooks ----------

export const webhookDeliveryStatusEnum = pgEnum('webhook_delivery_status', [
  'pending',
  'delivering',
  'delivered',
  'failed',
  'dead_letter',
]);

// ---------- Audit ----------

export const auditActorKindEnum = pgEnum('audit_actor_kind', [
  'firm_user',
  'admin_user',
  'api_key',
  'system',
  'customer',
]);

export const auditTargetKindEnum = pgEnum('audit_target_kind', [
  'firm',
  'firm_user',
  'admin_user',
  'api_key',
  'webhook_endpoint',
  'webhook_delivery',
  'kyc_session',
  'credential',
  'incident',
  'status_component',
  'customer',
  'ticket',
  'ticket_category',
  'role',
  'permission',
  'oauth_client',
  'oauth_consent',
]);

// ---------- Status page ----------

export const statusComponentStateEnum = pgEnum('status_component_state', [
  'operational',
  'degraded',
  'partial_outage',
  'major_outage',
  'maintenance',
]);

export const incidentSeverityEnum = pgEnum('incident_severity', ['minor', 'major', 'critical']);

export const incidentStatusEnum = pgEnum('incident_status', [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
]);

export const statusHistorySourceEnum = pgEnum('status_history_source', [
  'alertmanager',
  'blackbox',
  'manual',
  'api',
]);

// ---------- Tickets ----------

export const ticketStatusEnum = pgEnum('ticket_status', [
  'open',
  'in_progress',
  'waiting_customer',
  'resolved',
  'closed',
]);

export const ticketPriorityEnum = pgEnum('ticket_priority', ['low', 'normal', 'high', 'urgent']);

export const ticketCreatorTypeEnum = pgEnum('ticket_creator_type', ['customer', 'firm_user']);

export const ticketAudienceEnum = pgEnum('ticket_audience', ['customer', 'firm', 'any']);

/**
 * Role of an admin inside a ticket. `assignee` is the single owner that
 * drives status transitions and SLA timers; `collaborator` can read and
 * reply but cannot reassign or resolve. Exactly one `assignee` row per
 * ticket is enforced by a partial unique index in
 * `ticket_participants`.
 */
export const ticketParticipantRoleEnum = pgEnum('ticket_participant_role', [
  'assignee',
  'collaborator',
]);

/**
 * Lifecycle state of a participant row.
 *
 *   * `pending`  — invite sent to a same-level admin, awaiting response
 *     (expires after 1 day).
 *   * `active`   — participant can see + act on the ticket.
 *   * `declined` — same-level admin refused the invite; terminal.
 *   * `removed`  — kicked by a superior, voluntarily left, or the invite
 *     expired without a response; terminal.
 *
 * Lower-level direct-adds and superadmin join-as-collab skip `pending`
 * and are inserted with status `active` directly.
 */
export const ticketParticipantStatusEnum = pgEnum('ticket_participant_status', [
  'pending',
  'active',
  'declined',
  'removed',
]);
