import { getTableColumns, getTableName } from 'drizzle-orm';
import { type PgEnum, getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

// drizzle's PgEnum type is invariant in its value tuple so a helper typed
// against a single supertype rejects every concrete enum. The generic
// signature below accepts any pgEnum and collapses to a `readonly string[]`
// for assertion purposes.

import {
  adminUserRoleEnum,
  adminUsers,
  apiKeyModeEnum,
  apiKeys,
  auditActorKindEnum,
  auditLog,
  auditTargetKindEnum,
  canonicalNetworkEnum,
  credentialStatusEnum,
  credentialValidatorEnum,
  firmSettings,
  firmTierEnum,
  firmUserRoleEnum,
  firmUsers,
  firms,
  incidentSeverityEnum,
  incidentStatusEnum,
  kycCredentialsMeta,
  kycLevelEnum,
  kycSessionStatusEnum,
  kycSessionWorkflowEnum,
  kycSessions,
  quotaCounters,
  rateLimitBuckets,
  sessionKindEnum,
  sessions,
  statusComponentStateEnum,
  statusComponents,
  statusHistory,
  statusHistorySourceEnum,
  statusIncidents,
  statusSubscribers,
  usageAggregates,
  usageEvents,
  webhookDeliveries,
  webhookDeliveryStatusEnum,
  webhookEndpoints,
  webhookEvents,
} from '@/lib/db/schema';

function enumValues<T extends [string, ...string[]]>(pgEnum: PgEnum<T>): readonly string[] {
  return pgEnum.enumValues;
}

function columnNames(table: Parameters<typeof getTableColumns>[0]): readonly string[] {
  return Object.values(getTableColumns(table)).map((column) => column.name);
}

describe('@/lib/db/schema — Postgres enums', () => {
  it('firm_tier covers every billing tier exactly once', () => {
    expect(enumValues(firmTierEnum)).toEqual(['free', 'starter', 'pro', 'enterprise']);
  });

  it('api_key_mode distinguishes live and test keys', () => {
    expect(enumValues(apiKeyModeEnum)).toEqual(['live', 'test']);
  });

  it('session_kind separates firm dashboard sessions from admin and customer sessions', () => {
    // Sprint 14 Faz 1+ — `customer` joined the auth-session enum when
    // the customer-portal SSE/login flow stood up its own session
    // table. Sprint 7 introduced a separate `kyc_session_kind` enum
    // for the KYC-row discriminator (`customer` | `b2b`) — that one
    // is unrelated to this auth-session enum and lives in a sibling
    // export.
    expect(enumValues(sessionKindEnum)).toEqual(['firm', 'admin', 'customer']);
  });

  it('firm_user_role and admin_user_role expose distinct, disjoint role ladders', () => {
    expect(enumValues(firmUserRoleEnum)).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(enumValues(adminUserRoleEnum)).toEqual(['superadmin', 'admin', 'support']);
  });

  it('kyc_level mirrors the shared-types KycLevel union', () => {
    // Crivacy.KYCCredential v0.0.3 collapsed the level enum to
    // {basic, enhanced}.
    expect(enumValues(kycLevelEnum)).toEqual(['basic', 'enhanced']);
  });

  it('kyc_session_status covers the Didit two-phase workflow', () => {
    // The 11 values reflect the full Didit V3 status surface (Batch
    // A added `in_review` between `in_progress` and `identity_approved`,
    // Batch B appended `resubmission_pending` + `kyc_expired`).
    expect(enumValues(kycSessionStatusEnum)).toEqual([
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
  });

  it('kyc_session_workflow has exactly the identity + address phases', () => {
    expect(enumValues(kycSessionWorkflowEnum)).toEqual(['identity', 'address']);
  });

  it('credential_status adds pending and superseded to the shared-types CredentialStatus union', () => {
    // `superseded` joined when Phase 2 (address) credentials started
    // replacing Phase 1 (identity) credentials inside the same Chain
    // package — the old row is marked superseded rather than revoked
    // so the lifecycle semantics remain auditable.
    expect(enumValues(credentialStatusEnum)).toEqual([
      'pending',
      'active',
      'revoked',
      'expired',
      'superseded',
    ]);
  });

  it('credential_validator matches the on-chain ValidatorType variant', () => {
    expect(enumValues(credentialValidatorEnum)).toEqual(['didit', 'chain', 'zk']);
  });

  it('canonical_network is mainnet, devnet, or sepolia', () => {
    expect(enumValues(canonicalNetworkEnum)).toEqual(['mainnet', 'devnet', 'sepolia']);
  });

  it('webhook_delivery_status covers the full delivery lifecycle', () => {
    expect(enumValues(webhookDeliveryStatusEnum)).toEqual([
      'pending',
      'delivering',
      'delivered',
      'failed',
      'dead_letter',
    ]);
  });

  it('audit_actor_kind and audit_target_kind document every auditable subject', () => {
    // The lists grew organically with new actor/target surfaces:
    //   * `customer` actor — Faz 14+ self-service customer mutations.
    //   * `customer` target — admin operating on a customer record.
    //   * `ticket`, `ticket_category` — support-ticket subsystem.
    //   * `role`, `permission` — RBAC catalogue audits.
    //   * `oauth_client`, `oauth_consent` — firm-side OAuth lifecycle.
    expect(enumValues(auditActorKindEnum)).toEqual([
      'firm_user',
      'admin_user',
      'api_key',
      'system',
      'customer',
    ]);
    expect(enumValues(auditTargetKindEnum)).toEqual([
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
  });

  it('status_component_state includes the five operator-visible states', () => {
    expect(enumValues(statusComponentStateEnum)).toEqual([
      'operational',
      'degraded',
      'partial_outage',
      'major_outage',
      'maintenance',
    ]);
  });

  it('incident_severity and incident_status describe the runbook states', () => {
    expect(enumValues(incidentSeverityEnum)).toEqual(['minor', 'major', 'critical']);
    expect(enumValues(incidentStatusEnum)).toEqual([
      'investigating',
      'identified',
      'monitoring',
      'resolved',
    ]);
  });

  it('status_history_source lists every known input channel', () => {
    expect(enumValues(statusHistorySourceEnum)).toEqual([
      'alertmanager',
      'blackbox',
      'manual',
      'api',
    ]);
  });
});

describe('@/lib/db/schema — core firm + tenant tables', () => {
  it('firms table uses the expected snake-case columns', () => {
    expect(getTableName(firms)).toBe('firms');
    expect(columnNames(firms)).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'slug',
        'tier',
        'contact_email',
        'country_code',
        'billing_email',
        'support_url',
        'notes',
        'created_at',
        'updated_at',
        'deleted_at',
      ]),
    );
  });

  it('firm_settings has firm_id as the only primary key column', () => {
    const config = getTableConfig(firmSettings);
    expect(config.name).toBe('firm_settings');
    const pk = config.primaryKeys[0];
    expect(pk).toBeUndefined();
    const firmIdColumn = config.columns.find((c) => c.name === 'firm_id');
    expect(firmIdColumn?.primary).toBe(true);
  });

  it('firm_users enforces case-insensitive uniqueness on (firm_id, lower(email))', () => {
    const config = getTableConfig(firmUsers);
    const unique = config.indexes.find((i) => i.config.name === 'firm_users_firm_id_email_key');
    expect(unique).toBeDefined();
    expect(unique?.config.unique).toBe(true);
  });

  it('admin_users carries the TOTP enrolment columns (now nullable post recovery-code rollout)', () => {
    // Pre-Sprint-1 admins were forced to enrol TOTP at create time;
    // post recovery-code rollout the columns are nullable so a fresh
    // admin can authenticate via OTP-only or recovery-code while
    // they're still pending TOTP enrolment. The columns must exist
    // on the table; nullability is documented as an explicit `null`
    // tolerance because the OTP/TOTP uplift happens via a
    // post-create flow.
    const columns = getTableColumns(adminUsers);
    expect(columns.totpSecretCiphertext.notNull).toBe(false);
    expect(columns.totpSecretNonce.notNull).toBe(false);
    expect(columns.totpKeyVersion.notNull).toBe(false);
    expect(columns.totpEnrolledAt.notNull).toBe(false);
  });
});

describe('@/lib/db/schema — api keys + sessions', () => {
  it('api_keys has a unique index on prefix for O(1) lookup', () => {
    const config = getTableConfig(apiKeys);
    const unique = config.indexes.find((i) => i.config.name === 'api_keys_prefix_key');
    expect(unique?.config.unique).toBe(true);
  });

  it('api_keys stores bcrypt parameters alongside the hash for rotation', () => {
    const columns = getTableColumns(apiKeys);
    expect(columns.hashAlgorithm.notNull).toBe(true);
    expect(columns.hashParameters.notNull).toBe(true);
  });

  it('sessions enforces jti uniqueness for instant revocation', () => {
    const config = getTableConfig(sessions);
    const unique = config.indexes.find((i) => i.config.name === 'sessions_jwt_jti_key');
    expect(unique?.config.unique).toBe(true);
  });
});

describe('@/lib/db/schema — rate limit + quota', () => {
  it('rate_limit_buckets is keyed by firm_id only (aggregate across every key the firm issues)', () => {
    const columns = getTableColumns(rateLimitBuckets);
    expect(columns.firmId.primary).toBe(true);
  });

  it('quota_counters has a composite primary key on (firm_id, period)', () => {
    const config = getTableConfig(quotaCounters);
    const pk = config.primaryKeys.find((p) => p.getName() === 'quota_counters_pk');
    expect(pk).toBeDefined();
    expect(pk?.columns.map((c) => c.name)).toEqual(['firm_id', 'period']);
  });

});

describe('@/lib/db/schema — usage', () => {
  it('usage_events uses bigserial to keep insert cost low at scale', () => {
    const columns = getTableColumns(usageEvents);
    expect(columns.id.columnType).toBe('PgBigSerial53');
    expect(columns.id.primary).toBe(true);
  });

  it('usage_aggregates has a composite PK on (firm_id, endpoint, hour)', () => {
    const config = getTableConfig(usageAggregates);
    const pk = config.primaryKeys.find((p) => p.getName() === 'usage_aggregates_pk');
    expect(pk).toBeDefined();
    expect(pk?.columns.map((c) => c.name)).toEqual(['firm_id', 'endpoint', 'hour']);
  });
});

describe('@/lib/db/schema — KYC sessions + credentials', () => {
  it('kyc_sessions has the full Didit field set', () => {
    const names = columnNames(kycSessions);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'firm_id',
        'user_ref',
        'created_by_api_key_id',
        'workflow',
        'level',
        'status',
        'didit_session_id',
        'didit_workflow_id',
        'didit_decision_payload',
        'callback_url',
        'return_url',
        'metadata',
        'failure_reason',
        'attempts',
        'started_at',
        'completed_at',
        'expires_at',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('kyc_credentials_meta carries all on-chain verification flags', () => {
    const names = columnNames(kycCredentialsMeta);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'firm_id',
        'user_ref',
        'kyc_session_id',
        'chain_contract_id',
        'chain_package_name',
        'chain_template_id',
        'chain_network',
        'operator_party',
        'user_party',
        'level',
        'status',
        'validator',
        'proof_hash',
        'human_score',
        'identity_verified',
        'liveness_verified',
        'address_verified',
        'valid_from',
        'valid_until',
        'confirmed_at',
        'revoked_at',
        'revoked_reason',
        'expired_at',
        'disclosure_blob_cache',
        'disclosure_blob_fetched_at',
        'chain_submission_id',
        'created_at',
        'updated_at',
      ]),
    );
  });
});

describe('@/lib/db/schema — webhooks', () => {
  it('webhook_endpoints encrypts the signing secret at rest', () => {
    const columns = getTableColumns(webhookEndpoints);
    expect(columns.signingSecretCiphertext.notNull).toBe(true);
    expect(columns.signingSecretNonce.notNull).toBe(true);
    expect(columns.signingKeyVersion.notNull).toBe(true);
  });

  it('webhook_deliveries dedupes by (endpoint_id, event_id)', () => {
    const config = getTableConfig(webhookDeliveries);
    const unique = config.indexes.find(
      (i) => i.config.name === 'webhook_deliveries_endpoint_event_key',
    );
    expect(unique?.config.unique).toBe(true);
  });

  it('webhook_events enforces idempotency only when the key is present', () => {
    const config = getTableConfig(webhookEvents);
    const idempotency = config.indexes.find(
      (i) => i.config.name === 'webhook_events_idempotency_key',
    );
    expect(idempotency?.config.unique).toBe(true);
    expect(idempotency?.config.where).toBeDefined();
  });
});

describe('@/lib/db/schema — audit', () => {
  it('audit_log uses bigserial and keeps actor + target as nullable uuids', () => {
    const columns = getTableColumns(auditLog);
    expect(columns.id.columnType).toBe('PgBigSerial53');
    expect(columns.actorKind.notNull).toBe(true);
    expect(columns.actorId.notNull).toBe(false);
    expect(columns.targetKind.notNull).toBe(false);
    expect(columns.targetId.notNull).toBe(false);
    expect(columns.meta.notNull).toBe(true);
  });
});

describe('@/lib/db/schema — status page', () => {
  it('status_components uses group_name instead of the reserved word "group"', () => {
    const names = columnNames(statusComponents);
    expect(names).toContain('group_name');
    expect(names).not.toContain('group');
  });

  it('status_incidents stores affected components as a uuid[] column', () => {
    const columns = getTableColumns(statusIncidents);
    const componentIds = columns.componentIds;
    expect(componentIds.notNull).toBe(true);
  });

  it('status_history is a pure time-series with a bigserial PK', () => {
    const columns = getTableColumns(statusHistory);
    expect(columns.id.columnType).toBe('PgBigSerial53');
    expect(columns.componentId.notNull).toBe(true);
  });

  it('status_subscribers uses a functional unique index on lower(email)', () => {
    const config = getTableConfig(statusSubscribers);
    const unique = config.indexes.find((i) => i.config.name === 'status_subscribers_email_key');
    expect(unique?.config.unique).toBe(true);
  });
});
