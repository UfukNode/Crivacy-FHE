/**
 * Audit log query helpers.
 *
 * The dashboard and admin surfaces all paginate descending by
 * `(ts DESC, id DESC)` with an opaque cursor, so the queries here
 * accept a decoded cursor value and emit a new one for the next page.
 * We never expose the raw `id` — the cursor is a base64url-encoded
 * JSON `{ts, id}` tuple that is easy to rotate if we ever migrate
 * storage.
 *
 * All queries return `AuditQueryResult<T>`, a discriminated envelope
 * that carries the rows, the `nextCursor`, and the `hasMore` flag.
 * The caller renders the envelope into the public
 * `PaginatedCollection` OpenAPI shape by spreading the fields.
 *
 * Every SQL predicate is parameterized. We use Drizzle's typed query
 * builder to construct the WHERE clauses so Postgres can reuse the
 * plan cache, and so dangerous user input cannot slip through.
 */

import { type SQL, and, desc, eq, gte, lt, lte, or, sql } from 'drizzle-orm';

import type { CrivacyDatabase } from '@/lib/db/client';
import { auditLog } from '@/lib/db/schema';

import type { AuditAction } from './actions';
import { isAuditAction } from './actions';
import { AuditError } from './errors';
import type { AuditTargetKind } from './targets';
import type { PersistedAuditRow } from './writer';

/** Decoded cursor value. */
export interface AuditCursor {
  readonly ts: Date;
  readonly id: number;
}

/**
 * Encode a cursor to its opaque wire form. Base64url over a stable
 * JSON shape so rotation is cheap.
 */
export function encodeCursor(cursor: AuditCursor): string {
  const serialized = JSON.stringify({ ts: cursor.ts.toISOString(), id: cursor.id });
  return Buffer.from(serialized, 'utf8').toString('base64url');
}

/**
 * Decode a cursor from its wire form. Throws `AuditError` with
 * `invalid_cursor` on malformed input — callers map this to a 400.
 */
export function decodeCursor(value: string): AuditCursor {
  let json: string;
  try {
    json = Buffer.from(value, 'base64url').toString('utf8');
  } catch (cause) {
    throw AuditError.wrap('invalid_cursor', 'cursor is not valid base64url', cause);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw AuditError.wrap('invalid_cursor', 'cursor JSON failed to parse', cause);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AuditError('invalid_cursor', 'cursor JSON is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const tsRaw = obj['ts'];
  const idRaw = obj['id'];
  if (typeof tsRaw !== 'string') {
    throw new AuditError('invalid_cursor', 'cursor ts field is not a string');
  }
  if (typeof idRaw !== 'number' || !Number.isInteger(idRaw) || idRaw < 0) {
    throw new AuditError('invalid_cursor', 'cursor id field is not a non-negative integer');
  }
  const ts = new Date(tsRaw);
  if (Number.isNaN(ts.getTime())) {
    throw new AuditError('invalid_cursor', 'cursor ts failed to parse as a Date');
  }
  return { ts, id: idRaw };
}

/**
 * Common pagination input. `limit` is clamped at `MAX_QUERY_LIMIT`
 * server-side — callers should request 50 or 100 at a time from the
 * dashboard.
 */
export interface ListQueryInput {
  readonly limit?: number;
  readonly cursor?: AuditCursor;
  /** Only return rows with `ts >= from`. */
  readonly from?: Date;
  /** Only return rows with `ts <= to`. */
  readonly to?: Date;
  /** Optional action filter. */
  readonly action?: AuditAction;
  /** Optional action domain filter (e.g. `'firm_user'`). */
  readonly actionDomain?: string;
}

/** Upper bound on rows returned per page. */
export const MAX_QUERY_LIMIT = 500;
/** Default page size when the caller does not supply one. */
export const DEFAULT_QUERY_LIMIT = 50;

export interface AuditQueryResult<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

// ---------------- Public surface ----------------

/** List audit rows scoped to a single firm. */
export async function listByFirm(
  db: CrivacyDatabase,
  firmId: string,
  input: ListQueryInput = {},
): Promise<AuditQueryResult<PersistedAuditRow>> {
  assertFirmId(firmId);
  const where = and(eq(auditLog.firmId, firmId), ...baseWhere(input));
  return runList(db, where, input);
}

/** List audit rows for a specific actor. */
export async function listByActor(
  db: CrivacyDatabase,
  input: ListQueryInput & {
    readonly actorKind: 'firm_user' | 'admin_user' | 'api_key' | 'system';
    readonly actorId: string | null;
  },
): Promise<AuditQueryResult<PersistedAuditRow>> {
  const predicates: SQL[] = [eq(auditLog.actorKind, input.actorKind)];
  if (input.actorId !== null) {
    assertUuid(input.actorId, 'actorId');
    predicates.push(eq(auditLog.actorId, input.actorId));
  } else {
    predicates.push(sql`${auditLog.actorId} is null`);
  }
  const combined = and(...predicates, ...baseWhere(input));
  return runList(db, combined, input);
}

/** List audit rows for a specific target (uuid or ref keyed). */
export async function listByTarget(
  db: CrivacyDatabase,
  input: ListQueryInput & {
    readonly targetKind: AuditTargetKind;
    readonly targetId?: string;
    readonly targetRef?: string;
  },
): Promise<AuditQueryResult<PersistedAuditRow>> {
  if (input.targetId === undefined && input.targetRef === undefined) {
    throw new AuditError('read_failed', 'listByTarget requires targetId or targetRef');
  }
  const predicates: SQL[] = [eq(auditLog.targetKind, input.targetKind)];
  if (input.targetId !== undefined) {
    assertUuid(input.targetId, 'targetId');
    predicates.push(eq(auditLog.targetId, input.targetId));
  }
  if (input.targetRef !== undefined) {
    predicates.push(eq(auditLog.targetRef, input.targetRef));
  }
  const combined = and(...predicates, ...baseWhere(input));
  return runList(db, combined, input);
}

/**
 * Global list — used only by the admin audit viewer. Narrower
 * filters (firm / actor / target) should be preferred so Postgres
 * can pick a matching btree index instead of the `ts DESC` scan.
 */
export async function listGlobal(
  db: CrivacyDatabase,
  input: ListQueryInput = {},
): Promise<AuditQueryResult<PersistedAuditRow>> {
  return runList(db, and(...baseWhere(input)), input);
}

// ---------------- WHERE-clause construction ----------------

function baseWhere(input: ListQueryInput): SQL[] {
  const out: SQL[] = [];
  if (input.from !== undefined) {
    assertDate(input.from, 'from');
    out.push(gte(auditLog.ts, input.from));
  }
  if (input.to !== undefined) {
    assertDate(input.to, 'to');
    out.push(lte(auditLog.ts, input.to));
  }
  if (input.from !== undefined && input.to !== undefined) {
    if (input.from.getTime() > input.to.getTime()) {
      throw new AuditError('invalid_range', 'from must be <= to');
    }
  }
  if (input.action !== undefined) {
    if (!isAuditAction(input.action)) {
      throw new AuditError('invalid_action', 'action filter is not a member of AUDIT_ACTIONS');
    }
    out.push(eq(auditLog.action, input.action));
  }
  if (input.actionDomain !== undefined) {
    const domain = input.actionDomain;
    if (typeof domain !== 'string' || domain.length === 0 || domain.includes('%')) {
      throw new AuditError('read_failed', 'actionDomain must be a non-empty literal string');
    }
    out.push(sql`${auditLog.action} like ${`${domain}.%`}`);
  }
  if (input.cursor !== undefined) {
    assertDate(input.cursor.ts, 'cursor.ts');
    // Keyset pagination descending: `(ts, id) < (cursor.ts, cursor.id)`.
    out.push(
      or(
        lt(auditLog.ts, input.cursor.ts),
        and(eq(auditLog.ts, input.cursor.ts), lt(auditLog.id, input.cursor.id)) as SQL,
      ) as SQL,
    );
  }
  return out;
}

async function runList(
  db: CrivacyDatabase,
  where: SQL | undefined,
  input: ListQueryInput,
): Promise<AuditQueryResult<PersistedAuditRow>> {
  const limit = clampLimit(input.limit);
  const overFetch = limit + 1;
  const query = db
    .select()
    .from(auditLog)
    .where(where ?? sql`true`)
    .orderBy(desc(auditLog.ts), desc(auditLog.id))
    .limit(overFetch);

  let rawRows: unknown[];
  try {
    rawRows = (await query) as unknown[];
  } catch (cause) {
    throw AuditError.wrap('read_failed', 'audit list query failed', cause);
  }

  const hasMore = rawRows.length > limit;
  const sliced = hasMore ? rawRows.slice(0, limit) : rawRows;
  const rows = sliced.map((row) => hydrateSelectRow(row));

  const tail = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const nextCursor =
    hasMore && tail !== undefined ? encodeCursor({ ts: tail.ts, id: tail.id }) : null;

  return { rows, nextCursor, hasMore };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_QUERY_LIMIT;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new AuditError('read_failed', 'limit must be a positive integer');
  }
  if (limit > MAX_QUERY_LIMIT) {
    return MAX_QUERY_LIMIT;
  }
  return limit;
}

// ---------------- Row hydration (mirrors writer.hydrateRow) ----------------

function hydrateSelectRow(row: unknown): PersistedAuditRow {
  if (typeof row !== 'object' || row === null) {
    throw new AuditError('read_failed', 'driver returned a non-object select row');
  }
  const raw = row as Record<string, unknown>;
  const action = raw['action'];
  if (!isAuditAction(action)) {
    throw new AuditError('read_failed', 'select row has unknown action', {
      context: { action },
    });
  }
  return {
    id: requireNumber(raw['id'], 'id'),
    actorKind: requireActorKind(raw['actorKind']),
    actorId: nullableString(raw['actorId']),
    actorLabel: requireString(raw['actorLabel'], 'actorLabel'),
    firmId: nullableString(raw['firmId']),
    action,
    targetKind: requireTargetKind(raw['targetKind']),
    targetId: nullableString(raw['targetId']),
    targetRef: nullableString(raw['targetRef']),
    ip: nullableString(raw['ip']),
    userAgent: nullableString(raw['userAgent']),
    requestId: nullableString(raw['requestId']),
    meta: requireObject(raw['meta']),
    ts: requireDate(raw['ts']),
  };
}

const ALLOWED_TARGET_KINDS: readonly AuditTargetKind[] = [
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
  'role',
  'permission',
];

function requireTargetKind(value: unknown): AuditTargetKind | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new AuditError('read_failed', 'row.targetKind is not a string or null');
  }
  if (!(ALLOWED_TARGET_KINDS as readonly string[]).includes(value)) {
    throw new AuditError('read_failed', 'row.targetKind is unknown', {
      context: { received: value },
    });
  }
  return value as AuditTargetKind;
}

// ---------------- Small assertion helpers ----------------

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): void {
  if (!UUID_V4_REGEX.test(value)) {
    throw new AuditError('read_failed', `${field} must be a uuid v4 string`);
  }
}

function assertFirmId(value: string): void {
  if (typeof value !== 'string' || !UUID_V4_REGEX.test(value)) {
    throw new AuditError('read_failed', 'firmId must be a uuid v4 string');
  }
}

function assertDate(value: unknown, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AuditError('read_failed', `${field} must be a valid Date`);
  }
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AuditError('read_failed', `row.${field} is not a number`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AuditError('read_failed', `row.${field} is not a string`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new AuditError('read_failed', 'row field is not a nullable string');
  }
  return value;
}

function requireActorKind(value: unknown): 'firm_user' | 'admin_user' | 'api_key' | 'system' {
  if (
    value === 'firm_user' ||
    value === 'admin_user' ||
    value === 'api_key' ||
    value === 'system'
  ) {
    return value;
  }
  throw new AuditError('read_failed', 'row.actorKind is unknown', { context: { received: value } });
}

function requireObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuditError('read_failed', 'row.meta is not a plain object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw new AuditError('read_failed', 'row.ts is not a Date');
}
