/**
 * Target descriptors for the audit writer.
 *
 * The `audit_log` row has three target columns:
 *   * `target_kind` — enum of the subject class
 *   * `target_id` — uuid of the subject row (nullable)
 *   * `target_ref` — free-form short string for non-uuid identifiers
 *     (on-chain contract id, webhook event id, email address for an
 *     invited user that hasn't been created yet)
 *
 * Like `AuditActor`, the writer only accepts a `AuditTarget`
 * discriminated union constructed via the helpers in this file. The
 * `none` variant is the explicit "no subject" case; system actions
 * like `system.backup.started` use it.
 */

import { AuditError } from './errors';

/** Wire-type echo of `audit_target_kind` in `schema/enums.ts`. */
export type AuditTargetKind =
  | 'firm'
  | 'firm_user'
  | 'admin_user'
  | 'api_key'
  | 'webhook_endpoint'
  | 'webhook_delivery'
  | 'kyc_session'
  | 'credential'
  | 'incident'
  | 'status_component'
  | 'customer'
  | 'ticket'
  | 'ticket_category'
  | 'role'
  | 'permission'
  | 'oauth_client'
  | 'oauth_consent';

export interface NoneTarget {
  readonly kind: 'none';
}

export interface UuidTarget {
  readonly kind: AuditTargetKind;
  readonly id: string;
  readonly ref?: string;
}

/**
 * A target that carries a non-uuid reference string. Used by
 * `credential` (on-chain contract id), `webhook_delivery` (event id),
 * and by `firm_user` when we only know the email of an invitee.
 */
export interface RefTarget {
  readonly kind: AuditTargetKind;
  readonly id?: string;
  readonly ref: string;
}

export type AuditTarget = NoneTarget | UuidTarget | RefTarget;

// ---------------- Validation ----------------

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REF_LENGTH = 256;

const ALL_TARGET_KINDS: readonly AuditTargetKind[] = [
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
];

function requireKind(value: unknown): AuditTargetKind {
  if (typeof value !== 'string' || !(ALL_TARGET_KINDS as readonly string[]).includes(value)) {
    throw new AuditError('invalid_target', 'target.kind is not a known audit_target_kind', {
      context: { received: value },
    });
  }
  return value as AuditTargetKind;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_V4_REGEX.test(value)) {
    throw new AuditError('invalid_target', `${field} must be a uuid v4 string`, {
      context: { field, received: typeof value },
    });
  }
  return value;
}

function requireRef(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AuditError('invalid_target', `${field} must be a non-empty string`, {
      context: { field },
    });
  }
  if (value.length > MAX_REF_LENGTH) {
    throw new AuditError(
      'invalid_target',
      `${field} must be at most ${String(MAX_REF_LENGTH)} characters`,
      { context: { field, length: value.length } },
    );
  }
  return value;
}

// ---------------- Constructors ----------------

/** The "no target" singleton. Used by system actions. */
export function noTarget(): NoneTarget {
  return NONE_TARGET;
}

const NONE_TARGET: NoneTarget = Object.freeze({ kind: 'none' as const });

/**
 * Build a uuid-keyed target. If you have both a uuid and a ref
 * (e.g. a KYC session with its external session id), pass both and
 * they'll both be persisted.
 */
export function uuidTarget(input: {
  readonly kind: AuditTargetKind;
  readonly id: string;
  readonly ref?: string;
}): UuidTarget {
  return Object.freeze({
    kind: requireKind(input.kind),
    id: requireUuid(input.id, 'uuidTarget.id'),
    ...(input.ref !== undefined ? { ref: requireRef(input.ref, 'uuidTarget.ref') } : {}),
  });
}

/**
 * Build a target that only has a ref (not a uuid). Typical uses:
 *   * `firm_user` by email for an invite that hasn't been accepted
 *   * `credential` by on-chain contract id for a pre-sync event
 *   * `webhook_delivery` by external event id for a replay
 */
export function refTarget(input: {
  readonly kind: AuditTargetKind;
  readonly ref: string;
  readonly id?: string;
}): RefTarget {
  return Object.freeze({
    kind: requireKind(input.kind),
    ref: requireRef(input.ref, 'refTarget.ref'),
    ...(input.id !== undefined ? { id: requireUuid(input.id, 'refTarget.id') } : {}),
  });
}

/**
 * Narrow a target to its persisted-row shape. The writer calls this
 * just before the INSERT, and the query-layer row hydrator uses it
 * in reverse (`rowToTarget`) when rendering list results.
 */
export function targetToRow(target: AuditTarget): {
  readonly targetKind: AuditTargetKind | null;
  readonly targetId: string | null;
  readonly targetRef: string | null;
} {
  if (target.kind === 'none') {
    return { targetKind: null, targetId: null, targetRef: null };
  }
  return {
    targetKind: target.kind,
    targetId: target.id ?? null,
    targetRef: target.ref ?? null,
  };
}
