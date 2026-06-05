/**
 * Component group, a named group of status components with state + uptime.
 * @module
 */

import { UptimeBar } from './uptime-bar';

interface ComponentData {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly state: string;
}

interface DayStatus {
  readonly date: string;
  readonly state: string;
  readonly uptimePercent: number;
}

interface UptimeData {
  readonly days: readonly DayStatus[];
  readonly uptimePercent: number;
}

interface ComponentGroupProps {
  readonly groupName: string;
  readonly components: readonly ComponentData[];
  readonly uptimes: ReadonlyMap<string, UptimeData>;
}

const STATE_LABELS: Record<string, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  partial_outage: 'Partial Outage',
  major_outage: 'Major Outage',
  maintenance: 'Maintenance',
};

const STATE_DOT_COLORS: Record<string, string> = {
  operational: 'bg-[#22c55e]',
  degraded: 'bg-[#f59e0b]',
  partial_outage: 'bg-[#f97316]',
  major_outage: 'bg-[#ef4444]',
  maintenance: 'bg-[#6d5dfc]',
};

export function ComponentGroup({ groupName, components, uptimes }: ComponentGroupProps) {
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[var(--color-muted)]">
        {groupName}
      </h2>
      <div className="space-y-4">
        {components.map((comp) => {
          const uptime = uptimes.get(comp.id);
          const dotClass = STATE_DOT_COLORS[comp.state] ?? 'bg-[#22c55e]';
          const label = STATE_LABELS[comp.state] ?? 'Unknown';

          return (
            <div
              key={comp.id}
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
            >
              {/* Header: name + status dot */}
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium text-[var(--color-fg)]">{comp.name}</h3>
                  {comp.description !== null && (
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">{comp.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
                  <span className="text-xs font-medium text-[var(--color-muted)]">{label}</span>
                </div>
              </div>

              {/* Uptime bar */}
              {uptime !== undefined && (
                <UptimeBar days={uptime.days} uptimePercent={uptime.uptimePercent} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
