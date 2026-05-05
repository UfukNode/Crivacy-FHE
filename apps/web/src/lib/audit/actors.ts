/**
 * Actor descriptors for the audit writer.
 *
 * The `audit_log` row has three actor columns:
 *   * `actor_kind` — which participant class (`firm_user`, `admin_user`,
 *     `api_key`, or `system`)
 *   * `actor_id` — uuid of the underlying row (nullable for `system`
 *     and for failed `api_key` auth before any key is identified)
 *   * `actor_label` — a human-readable short string ("alice@acme.com",
 *     "crv_live_abc123…", "chain-block-worker") that the dashboard
 *     renders without joining the subject's table
 *
 * The writer accepts a discriminated union `AuditActor` that enforces
 * exactly one of these shapes per call. We deliberately do NOT accept
 * an ad-hoc object — constructing an actor must go through one of the
 * `firmUser`/`apiKey`/`adminUser`/`system` helpers so the kind/id
 * invariant cannot be broken by a typo.
 */

import { AuditError } from './errors';

/** Wire-type echo of `audit_actor_kind` in `schema/enums.ts`. */
export type AuditActorKind = 'firm_user' | 'admin_user' | 'api_key' | 'system' | 'customer';

export interface FirmUserActor {
  readonly kind: 'firm_user';
  /** `firm_users.id` */
  readonly id: string;
  /** Cached email or display name; stored verbatim. */
  readonly label: string;
  /** Parent firm id. Required — every firm user is scoped to a firm. */
  readonly firmId: string;
}

export interface AdminUserActor {
  readonly kind: 'admin_user';
  /** `admin_users.id` */
  readonly id: string;
  /** Admin display name or email. */
  readonly label: string;
}

export interface ApiKeyActor {
  readonly kind: 'api_key';
  /**
   * `api_keys.id`. Nullable in the underlying column but required
   * here — if you don't have the key row (auth failed before
   * lookup), use `systemActor('auth.api_key.unknown')` instead and
   * put the attempted prefix in `meta`.
   */
  readonly id: string;
  /** Prefix-only string like `crv_live_abc123def456` (12-char prefix). */
  readonly label: string;
  /** Owning firm id. */
  readonly firmId: string;
}

export interface SystemActor {
  readonly kind: 'system';
  /** Stable short identifier for the worker ("backup", "chain-sync"). */
  readonly label: string;
}

export interface CustomerActor {
  readonly kind: 'customer';
  /** `customers.id` */
  readonly id: string;
  /** Customer email or display name. */
  readonly label: string;
}

/**
 * Discriminated union. Use the `firmUserActor` / `adminUserActor` /
 * `apiKeyActor` / `systemActor` / `customerActor` helpers to construct
 * values of this type rather than building object literals inline.
 */
export type AuditActor = FirmUserActor | AdminUserActor | ApiKeyActor | SystemActor | CustomerActor;

// ---------------- UUID v4 guard ----------------

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_V4_REGEX.test(value)) {
    throw new AuditError('invalid_actor', `${field} must be a uuid v4 string`, {
      context: { field, received: typeof value },
    });
  }
  return value;
}

const MAX_LABEL_LENGTH = 320;

function requireLabel(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AuditError('invalid_actor', `${field} must be a non-empty string`, {
      context: { field },
    });
  }
  if (value.length > MAX_LABEL_LENGTH) {
    throw new AuditError(
      'invalid_actor',
      `${field} must be at most ${String(MAX_LABEL_LENGTH)} characters`,
      { context: { field, length: value.length } },
    );
  }
  return value;
}

// ---------------- Constructors ----------------

/**
 * Build a firm-user actor from the dashboard session claim. The
 * caller is expected to pass the firm id from the JWT's `firm_id`
 * claim, not from the request body — audit integrity relies on the
 * actor scoping being derived from trusted state.
 */
export function firmUserActor(input: {
  readonly id: string;
  readonly label: string;
  readonly firmId: string;
}): FirmUserActor {
  return Object.freeze({
    kind: 'firm_user' as const,
    id: requireUuid(input.id, 'firmUserActor.id'),
    label: requireLabel(input.label, 'firmUserActor.label'),
    firmId: requireUuid(input.firmId, 'firmUserActor.firmId'),
  });
}

/** Build an admin-user actor from the admin session claim. */
export function adminUserActor(input: {
  readonly id: string;
  readonly label: string;
}): AdminUserActor {
  return Object.freeze({
    kind: 'admin_user' as const,
    id: requireUuid(input.id, 'adminUserActor.id'),
    label: requireLabel(input.label, 'adminUserActor.label'),
  });
}

/**
 * Build an API key actor from a successfully-authenticated request.
 * The `label` must be the 12-char prefix — full key bytes never
 * enter the audit log.
 */
export function apiKeyActor(input: {
  readonly id: string;
  readonly label: string;
  readonly firmId: string;
}): ApiKeyActor {
  return Object.freeze({
    kind: 'api_key' as const,
    id: requireUuid(input.id, 'apiKeyActor.id'),
    label: requireLabel(input.label, 'apiKeyActor.label'),
    firmId: requireUuid(input.firmId, 'apiKeyActor.firmId'),
  });
}

/**
 * Build a system actor. Used for any action where there is no
 * backing user (workers, scheduled jobs, chain block advancement,
 * failed auth before identity is resolved).
 */
export function systemActor(label: string): SystemActor {
  return Object.freeze({
    kind: 'system' as const,
    label: requireLabel(label, 'systemActor.label'),
  });
}

/** Build a customer actor from the customer session. */
export function customerActor(input: {
  readonly id: string;
  readonly label: string;
}): CustomerActor {
  return Object.freeze({
    kind: 'customer' as const,
    id: requireUuid(input.id, 'customerActor.id'),
    label: requireLabel(input.label, 'customerActor.label'),
  });
}

/**
 * Build a human-readable label for a customer. Falls back to a
 * truncated wallet identifier when the customer has no email.
 */
export function customerLabel(customer: { email: string | null; id: string }): string {
  return customer.email ?? `wallet:${customer.id.slice(0, 8)}`;
}

/**
 * Narrow an actor to its persisted-row shape:
 *   * `actor_id` is the uuid or null
 *   * `firm_id` is the firm scoping or null
 *   * `actor_label` is always present
 *
 * Kept in this module (not in `writer.ts`) so it can be reused by
 * the query-layer stringifier without importing the writer surface.
 */
export function actorToRow(actor: AuditActor): {
  readonly actorKind: AuditActorKind;
  readonly actorId: string | null;
  readonly actorLabel: string;
  readonly firmId: string | null;
} {
  switch (actor.kind) {
    case 'firm_user':
      return {
        actorKind: 'firm_user',
        actorId: actor.id,
        actorLabel: actor.label,
        firmId: actor.firmId,
      };
    case 'admin_user':
      return {
        actorKind: 'admin_user',
        actorId: actor.id,
        actorLabel: actor.label,
        firmId: null,
      };
    case 'api_key':
      return {
        actorKind: 'api_key',
        actorId: actor.id,
        actorLabel: actor.label,
        firmId: actor.firmId,
      };
    case 'system':
      return {
        actorKind: 'system',
        actorId: null,
        actorLabel: actor.label,
        firmId: null,
      };
    case 'customer':
      return {
        actorKind: 'customer',
        actorId: actor.id,
        actorLabel: actor.label,
        firmId: null,
      };
  }
}
