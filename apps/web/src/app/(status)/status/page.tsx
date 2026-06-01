/**
 * /status, public status page.
 *
 * Server component that fetches live data from the database.
 * Revalidates every 60 seconds (ISR).
 *
 * @module
 */

import type { Metadata } from 'next';

import { ComponentGroup, IncidentList, StatusBanner, SubscribeForm } from '@/components/status';
import { getDatabaseClient } from '@/lib/db/client';
import { buildUptimeSummary, computeOverallState, groupComponents } from '@/lib/status';
import type { ComponentState, HistoryEntry, PublicComponent } from '@/lib/status';
import {
  listHistoryForUptime,
  listPublicComponents,
  listPublicIncidents,
} from '@/server/repositories/status';

export const dynamic = 'force-dynamic'; // Requires DB at request time

export const metadata: Metadata = {
  title: 'System Status',
  description: 'Current system status of the Crivacy KYC API platform.',
};

export default async function StatusPage() {
  const { db } = getDatabaseClient();
  const now = new Date();

  // Fetch data in parallel
  const [componentRows, historyRows, incidentRows] = await Promise.all([
    listPublicComponents(db),
    listHistoryForUptime(db, 90, now),
    listPublicIncidents(db, 30, now),
  ]);

  // Map DB rows to domain types
  const components: PublicComponent[] = componentRows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    group: row.groupName,
    state: row.currentState as ComponentState,
    updatedAt: row.updatedAt,
  }));

  // Compute overall state
  const overall = computeOverallState(components);

  // Group components for display
  const groups = groupComponents(components);

  // Build uptime summaries per component
  const uptimes = new Map<
    string,
    { days: { date: string; state: string; uptimePercent: number }[]; uptimePercent: number }
  >();
  for (const comp of components) {
    const compHistory: HistoryEntry[] = historyRows
      .filter((h) => h.componentId === comp.id)
      .map((h) => ({
        componentId: h.componentId,
        state: h.state as ComponentState,
        ts: h.ts,
      }));
    const summary = buildUptimeSummary(comp.id, compHistory, now);
    uptimes.set(comp.id, {
      days: summary.days.map((d) => ({
        date: d.date,
        state: d.state,
        uptimePercent: d.uptimePercent,
      })),
      uptimePercent: summary.uptimePercent,
    });
  }

  // Map incidents for display
  const incidents = incidentRows.map((row) => {
    const timeline = Array.isArray(row.updatesTimeline) ? row.updatesTimeline : [];
    const updates = timeline
      .filter((entry): entry is { at: string; status: string; body: string } => {
        if (typeof entry !== 'object' || entry === null) return false;
        const e = entry as Record<string, unknown>;
        return (
          typeof e['at'] === 'string' &&
          typeof e['status'] === 'string' &&
          typeof e['body'] === 'string'
        );
      })
      .map((entry) => ({
        at: entry.at,
        status: entry.status,
        body: entry.body,
      }));

    return {
      id: row.id,
      title: row.title,
      body: row.body,
      severity: row.severity,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      resolvedAt: row.resolvedAt !== null ? row.resolvedAt.toISOString() : null,
      updates,
    };
  });

  return (
    <div className="space-y-8">
      {/* Overall status banner */}
      <StatusBanner state={overall} />

      {/* Component groups with uptime bars */}
      {groups.length > 0 ? (
        <section className="space-y-6">
          {groups.map((group) => (
            <ComponentGroup
              key={group.groupName}
              groupName={group.groupName}
              components={group.components.map((c) => ({
                id: c.id,
                name: c.name,
                description: c.description,
                state: c.state,
              }))}
              uptimes={uptimes}
            />
          ))}
        </section>
      ) : (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-8 text-center">
          <p className="text-sm text-[var(--color-muted)]">No components configured yet.</p>
        </div>
      )}

      {/* Incident history */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-[var(--color-fg)]">Past Incidents</h2>
        <IncidentList incidents={incidents} />
      </section>

      {/* Subscribe */}
      <section>
        <SubscribeForm />
      </section>

      {/* Last updated */}
      <p className="text-center text-xs text-[var(--color-muted)]">
        Last updated: {now.toISOString()}
      </p>
    </div>
  );
}
