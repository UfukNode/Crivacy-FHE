/**
 * Audit log library public surface.
 *
 * Consumers should import from this module (`@/lib/audit`) rather
 * than reaching into individual files. The barrel re-exports every
 * type, constant, and function that belongs to the public contract
 * of the library — internal helpers used only by one module stay
 * unexported.
 *
 * Layering:
 *
 *   * `errors` — single error class + code union
 *   * `actions` — pinned event taxonomy
 *   * `actors` / `targets` / `context` — value-object constructors
 *   * `redact` — read-time PII scrubber
 *   * `writer` — synchronous INSERT (single + batch)
 *   * `query` — cursor-paginated SELECT helpers
 *   * `chain` — tamper-evident hash chain for exports
 */

export type { AuditErrorCode } from './errors';
export { AuditError, isAuditError } from './errors';

export type { AuditAction } from './actions';
export { ALL_AUDIT_ACTIONS, AUDIT_ACTIONS, auditActionDomain, isAuditAction } from './actions';

export type {
  AdminUserActor,
  ApiKeyActor,
  AuditActor,
  AuditActorKind,
  CustomerActor,
  FirmUserActor,
  SystemActor,
} from './actors';
export { actorToRow, adminUserActor, apiKeyActor, customerActor, firmUserActor, systemActor } from './actors';

export type { AuditTarget, AuditTargetKind, NoneTarget, RefTarget, UuidTarget } from './targets';
export { noTarget, refTarget, targetToRow, uuidTarget } from './targets';

export type { AuditRequestContext } from './context';
export { EMPTY_CONTEXT, MAX_USER_AGENT_LENGTH, buildRequestContext } from './context';

export type { RedactAction, RedactAudience, RedactOptions } from './redact';
export { mergeRedactionRules, redactMeta } from './redact';

export type { AuditDatabase, InsertAuditRow, PersistedAuditRow, WriteAuditInput } from './writer';
export {
  MAX_BATCH_SIZE,
  MAX_META_BYTES,
  buildInsertRow,
  writeAudit,
  writeAuditBatch,
} from './writer';

export type { AuditCursor, AuditQueryResult, ListQueryInput } from './query';
export {
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  decodeCursor,
  encodeCursor,
  listByActor,
  listByFirm,
  listByTarget,
  listGlobal,
} from './query';

export type { ChainEntry, ChainResult } from './chain';
export {
  CHAIN_FIELDS,
  CHAIN_FORMAT_VERSION,
  CHAIN_GENESIS_HASH,
  canonicalRowString,
  computeAuditChain,
  verifyAuditChain,
} from './chain';
