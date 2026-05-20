/**
 * Health + status handlers.
 *
 * These are the only public routes that use `publicRoute` (no auth).
 *
 * @module
 */

import type { NextResponse } from 'next/server';

import type { CrivacyDatabase } from '@/lib/db/client';
import { isMaintenanceMode } from '@/lib/env/maintenance';
import type { ComponentState, PublicComponent } from '@/lib/status';
import { computeOverallState } from '@/lib/status';

import type { RequestContext } from '../context';
import type { PublicComponentRow, PublicIncidentRow } from '../repositories/status';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/health — liveness probe with dependency checks.
 */
export async function handleHealthCheck(ctx: RequestContext): Promise<NextResponse> {
  const checks: Array<{
    name: string;
    ok: boolean;
    latencyMs: number | null;
    error: string | null;
  }> = [];

  // Database check
  const dbCheck = await checkDatabase(ctx);
  checks.push(dbCheck);

  const allOk = checks.every((c) => c.ok);

  const gitSha = process.env['GIT_SHA'] ?? '0000000';
  const version = process.env['npm_package_version'] ?? '0.0.0';

  // Expose maintenance-mode status alongside the normal liveness
  // payload so monitoring / status-page consumers can distinguish
  // "app crashed" (`ok: false`) from "intentionally paused"
  // (`ok: true`, `maintenance: true`). The health endpoint itself is
  // exempt from the `CRIVACY_MAINTENANCE_MODE` 503 gate (see
  // `lib/env/maintenance.ts::EXEMPT_PREFIXES`) — that's deliberate
  // so Prometheus / load-balancer keep scraping during an incident
  // and operators can watch `maintenance` transition back to `false`
  // after deactivation.
  const maintenance = isMaintenanceMode();

  const body = {
    ok: allOk,
    maintenance,
    version,
    gitSha,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    checks,
  };

  return ctx.json(body, allOk ? 200 : 503);
}

// ---------------------------------------------------------------------------
// Status handler dependencies
// ---------------------------------------------------------------------------

export interface StatusDeps {
  readonly listComponents: (db: CrivacyDatabase) => Promise<readonly PublicComponentRow[]>;
  readonly listIncidents: (
    db: CrivacyDatabase,
    days: number,
    now: Date,
  ) => Promise<readonly PublicIncidentRow[]>;
}

// ---------------------------------------------------------------------------
// Timeline parsing
// ---------------------------------------------------------------------------

interface ParsedTimelineEntry {
  readonly at: string;
  readonly status: string;
  readonly body: string;
}

/**
 * Safely parse the JSONB `updatesTimeline` column into a typed array.
 * Returns an empty array if the value is not an array or entries are
 * malformed.
 */
function parseUpdatesTimeline(raw: unknown): readonly ParsedTimelineEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: ParsedTimelineEntry[] = [];
  for (const item of raw) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'at' in item &&
      'status' in item &&
      'body' in item &&
      typeof (item as Record<string, unknown>)['at'] === 'string' &&
      typeof (item as Record<string, unknown>)['status'] === 'string' &&
      typeof (item as Record<string, unknown>)['body'] === 'string'
    ) {
      entries.push({
        at: (item as Record<string, unknown>)['at'] as string,
        status: (item as Record<string, unknown>)['status'] as string,
        body: (item as Record<string, unknown>)['body'] as string,
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Status handler
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/status — public component status.
 *
 * Reads from the `status_components` and `status_incidents` tables via
 * injected repository functions, computes the overall state, and returns
 * a JSON response matching the OpenAPI `StatusResponse` schema.
 */
export async function handleStatusCheck(
  deps: StatusDeps,
  ctx: RequestContext,
): Promise<NextResponse> {
  const [componentRows, incidentRows] = await Promise.all([
    deps.listComponents(ctx.db),
    deps.listIncidents(ctx.db, 30, ctx.now),
  ]);

  // Map DB rows to the PublicComponent shape expected by computeOverallState
  const components: readonly PublicComponent[] = componentRows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    group: row.groupName,
    state: row.currentState as ComponentState,
    updatedAt: row.updatedAt,
  }));

  const overall = computeOverallState(components);

  // Map components to API response shape
  const apiComponents = components.map((c) => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description,
    group: c.group,
    state: c.state,
    updatedAt: c.updatedAt.toISOString(),
  }));

  // Map incidents to API response shape with parsed timeline
  const activeIncidents = incidentRows.map((inc) => ({
    id: inc.id,
    title: inc.title,
    body: inc.body,
    severity: inc.severity,
    status: inc.status,
    componentIds: inc.componentIds,
    startedAt: inc.startedAt.toISOString(),
    identifiedAt: inc.identifiedAt !== null ? inc.identifiedAt.toISOString() : null,
    monitoringAt: inc.monitoringAt !== null ? inc.monitoringAt.toISOString() : null,
    resolvedAt: inc.resolvedAt !== null ? inc.resolvedAt.toISOString() : null,
    updates: parseUpdatesTimeline(inc.updatesTimeline),
  }));

  return ctx.json({
    overall,
    components: apiComponents,
    activeIncidents,
    generatedAt: ctx.now.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Health check helpers
// ---------------------------------------------------------------------------

async function checkDatabase(ctx: RequestContext): Promise<{
  name: string;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}> {
  const startMs = performance.now();
  try {
    // Simple query to verify DB connectivity
    const { sql } = await import('drizzle-orm');
    await ctx.db.execute(sql`SELECT 1`);
    const latencyMs = Math.round(performance.now() - startMs);
    return { name: 'database', ok: true, latencyMs, error: null };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startMs);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { name: 'database', ok: false, latencyMs, error: message };
  }
}
