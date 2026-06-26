/**
 * TestFirm persistent data store.
 *
 * Three record kinds live here — the data a real B2B consumer of
 * Crivacy would keep in its own DB:
 *
 *   1. OAuth identities: per (firmUserId, crivacySub), the last
 *      claim set TestFirm pulled from `/oauth/userinfo`. Lets the
 *      firm show the user "you're verified" without hitting Crivacy
 *      on every page load.
 *
 *   2. KYC sessions: per session_id created via the Session API,
 *      the verification URL, current status, and which TestFirm user
 *      initiated it. Webhooks about that session mutate `status`.
 *
 *   3. Webhook events: every signed event Crivacy delivered,
 *      append-only, so a developer can see the audit trail across
 *      restarts.
 *
 * Backed by a single JSON file (`.test-firm-data.json`) so the
 * harness behaves like a real firm that persists what Crivacy
 * returns — not like a display-only dashboard that forgets every
 * refresh. Gitignored via `.test-firm-*.json`.
 *
 * Concurrency note: this store is synchronous and single-writer by
 * design. Next.js dev serves requests on one Node process, so the
 * Map reads/writes don't race. The JSON rewrite is atomic-ish (full
 * file rewrite) which is fine for a dev harness — swap for a real
 * DB in production.
 */

import 'server-only';

import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface UserinfoClaims {
  readonly sub?: string;
  readonly identity_verified?: boolean;
  readonly liveness_verified?: boolean;
  readonly address_verified?: boolean;
  readonly humanity_score?: number;
  readonly credential_proof_hash?: string;
  readonly credential_level?: string;
  readonly credential_valid_until?: string;
  readonly credential_network?: string;
  readonly credential_contract_id?: string | null;
}

export interface OauthIdentityRecord {
  readonly firmUserId: string;
  readonly crivacySub: string;
  readonly scope: string;
  readonly claims: UserinfoClaims;
  readonly firstLinkedAt: string; // ISO
  readonly lastUpdatedAt: string; // ISO
  /**
   * Lifecycle flags driven off `credential.*` webhook events. Stored
   * alongside the userinfo snapshot so the verified card can render
   * the current trust state without re-hitting Crivacy on every page
   * load. `revokedAt` is set when Crivacy or the user revokes the
   * credential on the CrivacyKYC contract on Sepolia; `expiredAt` is
   * set when the credential's `valid_until` passes. Both are
   * **cleared** if a fresh OAuth link replaces this record (the
   * user re-verified) — `upsertOauthIdentity` resets them.
   */
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
  readonly expiredAt: string | null;
}

export interface KycSessionRecord {
  readonly id: string; // Crivacy session id
  readonly firmUserId: string;
  readonly userRef: string;
  readonly workflow: string;
  readonly level: string;
  readonly verificationUrl: string | null;
  status: string;
  readonly createdAt: string;
  lastStatusUpdateAt: string;
  readonly createSnapshot: unknown;
}

export interface WebhookEventRecord {
  readonly id: string;
  readonly receivedAt: string;
  readonly eventType: string;
  readonly crivacyEventId: string | null;
  readonly crivacyDeliveryId: string | null;
  readonly signatureValid: boolean;
  readonly payload: unknown;
}

interface Persisted {
  readonly version: 1;
  readonly oauthIdentities: OauthIdentityRecord[];
  readonly kycSessions: KycSessionRecord[];
  readonly webhookEvents: WebhookEventRecord[];
}

const PERSIST_PATH = join(process.cwd(), '.test-firm-data.json');
const MAX_WEBHOOK_EVENTS = 500;

let loaded = false;
const oauthIdentities: OauthIdentityRecord[] = [];
const kycSessions = new Map<string, KycSessionRecord>();
const webhookEvents: WebhookEventRecord[] = [];

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(PERSIST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Persisted;
    if (parsed.version !== 1) return;
    for (const row of parsed.oauthIdentities ?? []) {
      // Backward-compat: older snapshots predate the lifecycle flags
      // (added 2026-05-11). Default them so we don't carry undefineds
      // through the rest of the codebase. New records always write
      // the fields explicitly so this only kicks in for existing
      // snapshot files.
      oauthIdentities.push({
        ...row,
        revokedAt: row.revokedAt ?? null,
        revokeReason: row.revokeReason ?? null,
        expiredAt: row.expiredAt ?? null,
      });
    }
    for (const row of parsed.kycSessions ?? []) kycSessions.set(row.id, row);
    for (const row of parsed.webhookEvents ?? []) webhookEvents.push(row);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.warn('[test-firm] failed to load data store:', (err as Error).message);
    }
  }
}

function persist(): void {
  const payload: Persisted = {
    version: 1,
    oauthIdentities: oauthIdentities.slice(),
    kycSessions: Array.from(kycSessions.values()),
    webhookEvents: webhookEvents.slice(),
  };
  try {
    writeFileSync(PERSIST_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[test-firm] failed to persist data store:', (err as Error).message);
  }
}

/* ---------- OAuth identity ---------- */

export function upsertOauthIdentity(input: {
  firmUserId: string;
  crivacySub: string;
  scope: string;
  claims: UserinfoClaims;
}): OauthIdentityRecord {
  ensureLoaded();
  const now = new Date().toISOString();
  const existingIndex = oauthIdentities.findIndex(
    (r) => r.firmUserId === input.firmUserId && r.crivacySub === input.crivacySub,
  );
  if (existingIndex >= 0) {
    const prev = oauthIdentities[existingIndex]!;
    // Re-linking resets lifecycle flags: a fresh OAuth grant means the
    // user is back to "verified" regardless of prior revoke/expire.
    // The Crivacy server-side state is the source of truth at link
    // time; staying in a stale `revokedAt` would lie about the new
    // grant. Webhooks landing later flip the flags back if needed.
    const next: OauthIdentityRecord = {
      firmUserId: prev.firmUserId,
      crivacySub: prev.crivacySub,
      scope: input.scope,
      claims: input.claims,
      firstLinkedAt: prev.firstLinkedAt,
      lastUpdatedAt: now,
      revokedAt: null,
      revokeReason: null,
      expiredAt: null,
    };
    oauthIdentities[existingIndex] = next;
    persist();
    return next;
  }
  const record: OauthIdentityRecord = {
    firmUserId: input.firmUserId,
    crivacySub: input.crivacySub,
    scope: input.scope,
    claims: input.claims,
    firstLinkedAt: now,
    lastUpdatedAt: now,
    revokedAt: null,
    revokeReason: null,
    expiredAt: null,
  };
  oauthIdentities.push(record);
  persist();
  return record;
}

export function listOauthIdentitiesForUser(firmUserId: string): readonly OauthIdentityRecord[] {
  ensureLoaded();
  return oauthIdentities.filter((r) => r.firmUserId === firmUserId);
}

/**
 * Lookup by Crivacy subject id — used by the webhook receiver to
 * find the firm-side identity row when a `credential.*` event lands.
 * Returns `null` when no firm user has linked this Crivacy account
 * (a webhook for an unknown sub is dropped at the caller).
 */
export function findOauthIdentityByCrivacySub(
  crivacySub: string,
): OauthIdentityRecord | null {
  ensureLoaded();
  return oauthIdentities.find((r) => r.crivacySub === crivacySub) ?? null;
}

/**
 * Mark an OAuth identity revoked. Driven by `credential.revoked` /
 * `credential.expired` webhook events. The credential snapshot on
 * the record stays intact so the UI can render "previously verified"
 * context; only the lifecycle flag flips. Returns the updated record
 * or `null` if no identity matches the subject.
 */
export function markOauthIdentityRevoked(input: {
  crivacySub: string;
  reason: string;
}): OauthIdentityRecord | null {
  ensureLoaded();
  const index = oauthIdentities.findIndex((r) => r.crivacySub === input.crivacySub);
  if (index < 0) return null;
  const prev = oauthIdentities[index]!;
  if (prev.revokedAt !== null) return prev; // idempotent
  const now = new Date().toISOString();
  const next: OauthIdentityRecord = {
    ...prev,
    lastUpdatedAt: now,
    revokedAt: now,
    revokeReason: input.reason,
  };
  oauthIdentities[index] = next;
  persist();
  return next;
}

/**
 * Mark an OAuth identity expired. Distinct from revoked: expiry is a
 * lifecycle event driven by the credential's `valid_until` timestamp
 * passing, not by Crivacy/firm action. The verified card's banner
 * copy differs ("expired — please re-verify" vs. "revoked — contact
 * support"), so the data-store carries the two states separately.
 */
export function markOauthIdentityExpired(input: {
  crivacySub: string;
}): OauthIdentityRecord | null {
  ensureLoaded();
  const index = oauthIdentities.findIndex((r) => r.crivacySub === input.crivacySub);
  if (index < 0) return null;
  const prev = oauthIdentities[index]!;
  if (prev.expiredAt !== null) return prev;
  const now = new Date().toISOString();
  const next: OauthIdentityRecord = {
    ...prev,
    lastUpdatedAt: now,
    expiredAt: now,
  };
  oauthIdentities[index] = next;
  persist();
  return next;
}

/**
 * Remove every OAuth identity for a firm user. Powers the
 * "Unlink Crivacy" action in the dashboard — distinct from the
 * test-firm logout button. A re-link via `Verify with Crivacy`
 * creates a fresh record (firstLinkedAt resets).
 * Returns the count of rows deleted.
 */
export function deleteOauthIdentitiesForUser(firmUserId: string): number {
  ensureLoaded();
  const before = oauthIdentities.length;
  for (let i = oauthIdentities.length - 1; i >= 0; i -= 1) {
    const row = oauthIdentities[i]!;
    if (row.firmUserId === firmUserId) {
      oauthIdentities.splice(i, 1);
    }
  }
  const removed = before - oauthIdentities.length;
  if (removed > 0) persist();
  return removed;
}

/* ---------- KYC sessions ---------- */

export function recordKycSession(input: {
  id: string;
  firmUserId: string;
  userRef: string;
  workflow: string;
  level: string;
  verificationUrl: string | null;
  status: string;
  createSnapshot: unknown;
}): KycSessionRecord {
  ensureLoaded();
  const now = new Date().toISOString();
  const record: KycSessionRecord = {
    id: input.id,
    firmUserId: input.firmUserId,
    userRef: input.userRef,
    workflow: input.workflow,
    level: input.level,
    verificationUrl: input.verificationUrl,
    status: input.status,
    createdAt: now,
    lastStatusUpdateAt: now,
    createSnapshot: input.createSnapshot,
  };
  kycSessions.set(record.id, record);
  persist();
  return record;
}

export function updateKycSessionStatus(id: string, status: string): KycSessionRecord | null {
  ensureLoaded();
  const record = kycSessions.get(id);
  if (record === undefined) return null;
  const now = new Date().toISOString();
  const next: KycSessionRecord = {
    ...record,
    status,
    lastStatusUpdateAt: now,
  };
  kycSessions.set(id, next);
  persist();
  return next;
}

export function listKycSessionsForUser(firmUserId: string): readonly KycSessionRecord[] {
  ensureLoaded();
  return Array.from(kycSessions.values())
    .filter((r) => r.firmUserId === firmUserId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ---------- Webhook events ---------- */

export function recordWebhookEvent(input: {
  eventType: string;
  crivacyEventId: string | null;
  crivacyDeliveryId: string | null;
  signatureValid: boolean;
  payload: unknown;
}): WebhookEventRecord {
  ensureLoaded();
  const record: WebhookEventRecord = {
    id: randomUUID(),
    receivedAt: new Date().toISOString(),
    eventType: input.eventType,
    crivacyEventId: input.crivacyEventId,
    crivacyDeliveryId: input.crivacyDeliveryId,
    signatureValid: input.signatureValid,
    payload: input.payload,
  };
  webhookEvents.unshift(record);
  if (webhookEvents.length > MAX_WEBHOOK_EVENTS) {
    webhookEvents.length = MAX_WEBHOOK_EVENTS;
  }
  persist();
  return record;
}

export function listWebhookEvents(): readonly WebhookEventRecord[] {
  ensureLoaded();
  return webhookEvents.slice();
}
