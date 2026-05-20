/**
 * Admin global audit log handler — all firms, all actions.
 *
 * @module
 */

import type { CrivacyDatabase } from '@/lib/db/client';

import type { AdminContext } from '../context';
import type { AdminAuditEntry } from '../repositories/admin';

/* ---------- Types ---------- */

export interface AdminAuditDeps {
  readonly listGlobalAudit: (
    db: CrivacyDatabase,
    opts?: {
      readonly firmId?: string | undefined;
      readonly action?: string | undefined;
      readonly actorKind?: string | undefined;
      readonly limit?: number | undefined;
      readonly offset?: number | undefined;
    },
  ) => Promise<{ entries: readonly AdminAuditEntry[]; total: number }>;
}

export interface ListGlobalAuditInput {
  readonly firmId?: string | undefined;
  readonly action?: string | undefined;
  readonly actorKind?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface ListGlobalAuditResult {
  readonly entries: readonly AdminAuditEntry[];
  readonly total: number;
}

/* ---------- Handler ---------- */

export async function handleListGlobalAudit(
  deps: AdminAuditDeps,
  ctx: AdminContext,
  input: ListGlobalAuditInput = {},
): Promise<ListGlobalAuditResult> {
  return deps.listGlobalAudit(ctx.db, input);
}
