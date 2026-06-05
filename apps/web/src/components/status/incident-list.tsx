/**
 * Incident list, recent incidents displayed on the public status page.
 * @module
 */

interface TimelineEntry {
  readonly at: string;
  readonly status: string;
  readonly body: string;
}

interface IncidentData {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly status: string;
  readonly startedAt: string;
  readonly resolvedAt: string | null;
  readonly updates: readonly TimelineEntry[];
}

interface IncidentListProps {
  readonly incidents: readonly IncidentData[];
}

const SEVERITY_BADGES: Record<string, { label: string; className: string }> = {
  minor: {
    label: 'Minor',
    className: 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]',
  },
  major: {
    label: 'Major',
    className: 'bg-[var(--color-warning)]/20 text-[var(--color-warning)]',
  },
  critical: {
    label: 'Critical',
    className: 'bg-[var(--color-danger)]/10 text-[var(--color-danger)]',
  },
};

const STATUS_LABELS: Record<string, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function IncidentList({ incidents }: IncidentListProps) {
  if (incidents.length === 0) {
    return (
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-8 text-center">
        <p className="text-sm text-[var(--color-muted)]">
          No incidents reported in the last 30 days.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {incidents.map((incident) => {
        const badge = SEVERITY_BADGES[incident.severity] ?? {
          label: 'Minor',
          className: 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]',
        };
        const statusLabel = STATUS_LABELS[incident.status] ?? incident.status;

        return (
          <div
            key={incident.id}
            className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--color-fg)]">{incident.title}</h3>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {formatDate(incident.startedAt)}
                  {incident.resolvedAt !== null && `, Resolved ${formatDate(incident.resolvedAt)}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-[var(--radius-full)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${badge.className}`}
                >
                  {badge.label}
                </span>
                <span className="rounded-[var(--radius-full)] bg-[var(--color-border)] px-2.5 py-0.5 text-[10px] font-medium text-[var(--color-muted)]">
                  {statusLabel}
                </span>
              </div>
            </div>

            {/* Body */}
            <p className="text-[var(--color-fg)]/80 mt-3 text-sm leading-relaxed">
              {incident.body}
            </p>

            {/* Timeline updates */}
            {incident.updates.length > 0 && (
              <div className="mt-4 border-t border-[var(--color-border)] pt-3">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
                  Updates
                </h4>
                <div className="space-y-2">
                  {incident.updates.map((update, idx) => (
                    <div
                      key={`${incident.id}-update-${String(idx)}`}
                      className="flex gap-3 text-xs"
                    >
                      <span className="shrink-0 text-[var(--color-muted)]">
                        {formatDateTime(update.at)}
                      </span>
                      <span className="shrink-0 font-medium text-[var(--color-fg)]">
                        {STATUS_LABELS[update.status] ?? update.status}
                      </span>
                      <span className="text-[var(--color-fg)]/70">{update.body}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
