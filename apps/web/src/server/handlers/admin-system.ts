/**
 * Admin system handlers — metrics, queue depth.
 *
 * @module
 */

import type { CrivacyDatabase } from '@/lib/db/client';

import type { AdminContext } from '../context';

/* ---------- Types ---------- */

export interface SystemMetrics {
  readonly totalFirms: number;
  readonly activeFirms: number;
  readonly totalSessions: number;
  readonly activeSessions: number;
  readonly totalAuditEntries: number;
  readonly totalIncidents: number;
  readonly activeIncidents: number;
}

export interface AdminSystemDeps {
  readonly getMetrics: (db: CrivacyDatabase) => Promise<SystemMetrics>;
}

/* ---------- Metrics ---------- */

export async function handleGetSystemMetrics(
  deps: AdminSystemDeps,
  ctx: AdminContext,
): Promise<SystemMetrics> {
  return deps.getMetrics(ctx.db);
}
