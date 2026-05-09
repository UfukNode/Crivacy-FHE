/**
 * IP-abuse signal counter — Sprint 6's repeat-evader gate.
 *
 * Every `fraud.face_match_blocked` event increments a per-IP
 * counter (keyed by salted hash of the client IP). When the
 * counter passes the 3-strike threshold within a 7-day window,
 * the next start-session call from that IP is rejected with
 * HTTP 503 BEFORE going to Didit — saves Didit cost on a
 * known abuser and short-circuits the cascade detection path.
 *
 * Privacy: NEVER store raw IP. The hashing layer here is the
 * only place that touches the raw value; everything downstream
 * (DB, audit log, admin UI) sees only the hash.
 *
 * Knobs:
 *   - `IP_ABUSE_HASH_SECRET` env — required. The hash salt.
 *     Rotation invalidates all existing rows by design (a
 *     privacy-friendly soft-reset). No fallback — fail loudly
 *     at startup so the operator notices.
 *   - `IP_ABUSE_THRESHOLD` env — optional. Default 3 strikes.
 *     The number of `fraud.face_match_blocked` events within
 *     the active window that flips the gate from OFF to ON.
 *   - `IP_ABUSE_TTL_DAYS` env — optional. Default 7 days. How
 *     far back the counter looks; older `last_seen` rows are
 *     pruned by the nightly job.
 */

import { createHash } from 'node:crypto';

import { and, eq, lt, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';

export const IP_ABUSE_DEFAULT_THRESHOLD = 3;
export const IP_ABUSE_DEFAULT_TTL_DAYS = 7;

/**
 * Read + validate the hash secret. Throws if missing — by design
 * (matches `lib/env/app-url.ts:62`'s "fail loud at first request"
 * pattern). Memoized after first read.
 */
let cachedSecret: string | null = null;
function getHashSecret(): string {
  if (cachedSecret !== null) return cachedSecret;
  const raw = process.env['IP_ABUSE_HASH_SECRET']?.trim() ?? '';
  if (raw.length < 16) {
    throw new Error(
      '[ip-abuse] IP_ABUSE_HASH_SECRET is required and must be at least 16 characters.' +
        ' Set the env to a high-entropy random string before starting the server.',
    );
  }
  cachedSecret = raw;
  return cachedSecret;
}

function readThreshold(): number {
  const raw = process.env['IP_ABUSE_THRESHOLD'];
  if (raw === undefined || raw.length === 0) return IP_ABUSE_DEFAULT_THRESHOLD;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : IP_ABUSE_DEFAULT_THRESHOLD;
}

function readTtlDays(): number {
  const raw = process.env['IP_ABUSE_TTL_DAYS'];
  if (raw === undefined || raw.length === 0) return IP_ABUSE_DEFAULT_TTL_DAYS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : IP_ABUSE_DEFAULT_TTL_DAYS;
}

/**
 * Hash a client IP into the storage form. Uses SHA-256 over
 * `${ip}:${secret}` to bind the hash to this deployment — a hash
 * leaked from the DB cannot be replayed against a different
 * deployment's table without also leaking the secret.
 *
 * Lower-cases / trims the input first so two requests from the
 * same IP that differ only in formatting (IPv4 vs IPv4-mapped
 * IPv6) hash the same. Non-string / empty input returns the
 * empty hash so the caller sees a stable failure mode.
 */
export function hashIp(ip: string | null | undefined): string {
  if (typeof ip !== 'string') return '';
  const trimmed = ip.trim().toLowerCase();
  if (trimmed.length === 0) return '';
  return createHash('sha256').update(`${trimmed}:${getHashSecret()}`).digest('hex');
}

/**
 * UPSERT-increment a counter for the given hashed IP.
 *
 * Behaviour:
 *   - First sighting → INSERT row with `count = 1`, `first_seen
 *     = last_seen = now`.
 *   - Subsequent within TTL window → UPDATE: `count = count + 1`,
 *     `last_seen = now`. `first_seen` is preserved.
 *   - Subsequent past TTL window → DELETE-then-INSERT semantics
 *     (the prune job catches the stale row eventually; until
 *     then the increment treats it as still-active and bumps
 *     the count). This is intentional — repeat abuse from
 *     month-old hash should still register as repeat, just
 *     with a longer recovery window.
 *
 * Returns the post-increment row so callers can immediately
 * decide whether the threshold tripped without a separate read.
 */
export async function incrementSignal(
  db: CrivacyDatabase,
  ipHash: string,
  now: Date = new Date(),
): Promise<{ readonly count: number; readonly firstSeen: Date; readonly lastSeen: Date }> {
  if (ipHash.length === 0) {
    // Empty hash — caller couldn't extract a usable IP. Treat as
    // a no-op so the gate doesn't false-positive. The caller is
    // responsible for logging the missing-IP path.
    return { count: 0, firstSeen: now, lastSeen: now };
  }
  const inserted = await db
    .insert(schema.ipAbuseSignals)
    .values({
      ipHash,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    })
    .onConflictDoUpdate({
      target: schema.ipAbuseSignals.ipHash,
      set: {
        count: sql`${schema.ipAbuseSignals.count} + 1`,
        lastSeen: now,
      },
    })
    .returning({
      count: schema.ipAbuseSignals.count,
      firstSeen: schema.ipAbuseSignals.firstSeen,
      lastSeen: schema.ipAbuseSignals.lastSeen,
    });
  const row = inserted[0];
  if (row === undefined) {
    return { count: 0, firstSeen: now, lastSeen: now };
  }
  return row;
}

/**
 * Read the current count for an IP within the TTL window. Returns
 * `0` when the IP has no row OR its `last_seen` is older than the
 * window (treated as "no signal", consistent with the prune
 * semantics).
 */
export async function getCount(
  db: CrivacyDatabase,
  ipHash: string,
  ttlDays: number = readTtlDays(),
  now: Date = new Date(),
): Promise<number> {
  if (ipHash.length === 0) return 0;
  const cutoff = new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ count: schema.ipAbuseSignals.count })
    .from(schema.ipAbuseSignals)
    .where(
      and(
        eq(schema.ipAbuseSignals.ipHash, ipHash),
        sql`${schema.ipAbuseSignals.lastSeen} >= ${cutoff}`,
      ),
    )
    .limit(1);
  return rows[0]?.count ?? 0;
}

/**
 * The pre-Didit gate's threshold check. `true` means the IP has
 * tripped the repeat-evader threshold and the start-session call
 * should fail with 503 before going to Didit.
 */
export async function isOverThreshold(
  db: CrivacyDatabase,
  ipHash: string,
  threshold: number = readThreshold(),
  ttlDays: number = readTtlDays(),
  now: Date = new Date(),
): Promise<boolean> {
  const count = await getCount(db, ipHash, ttlDays, now);
  return count >= threshold;
}

/**
 * DELETE rows with `last_seen` older than the TTL. Run by a daily
 * cron; safe to run any number of times (idempotent — every
 * surviving row has a last_seen within the window).
 */
export async function pruneExpired(
  db: CrivacyDatabase,
  ttlDays: number = readTtlDays(),
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(schema.ipAbuseSignals)
    .where(lt(schema.ipAbuseSignals.lastSeen, cutoff))
    .returning({ ipHash: schema.ipAbuseSignals.ipHash });
  return deleted.length;
}

/**
 * Test-only helper — drop the memoised secret so per-case env
 * overrides apply. Mirrors `lib/env/app-url.ts::resetAppUrlForTests`.
 */
export function resetIpAbuseCacheForTests(): void {
  cachedSecret = null;
}
