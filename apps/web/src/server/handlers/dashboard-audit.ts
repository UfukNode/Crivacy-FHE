/**
 * Dashboard audit log viewer handler.
 *
 * @module
 */

import type { DashboardContext } from '../context';

/* ---------- Types ---------- */

export interface AuditListItem {
  readonly id: number;
  readonly action: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly actorLabel: string | null;
  readonly targetKind: string | null;
  readonly targetId: string | null;
  readonly targetRef: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly meta: Record<string, unknown> | null;
  readonly ts: Date;
}

export interface AuditListResult {
  readonly entries: readonly AuditListItem[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/* ---------- DI ---------- */

export interface AuditLogDeps {
  readonly listAuditEntries: (
    ctx: DashboardContext,
    opts: {
      readonly action?: string;
      readonly limit?: number;
      readonly cursor?: string;
    },
  ) => Promise<AuditListResult>;
}

/* ---------- Handler ---------- */

/**
 * List audit log entries for the firm.
 */
export async function handleListAuditEntries(
  deps: AuditLogDeps,
  ctx: DashboardContext,
  opts: {
    readonly action?: string;
    readonly limit?: number;
    readonly cursor?: string;
  },
): Promise<AuditListResult> {
  return deps.listAuditEntries(ctx, opts);
}
