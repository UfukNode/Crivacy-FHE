/**
 * 90-day uptime bar, SVG visualization of daily component status.
 *
 * Each day is a thin vertical bar. Color codes:
 *   - operational: green
 *   - degraded: yellow
 *   - partial_outage: orange
 *   - major_outage: red
 *   - maintenance: purple/accent
 *
 * @module
 */

interface DayStatus {
  readonly date: string;
  readonly state: string;
  readonly uptimePercent: number;
}

interface UptimeBarProps {
  readonly days: readonly DayStatus[];
  readonly uptimePercent: number;
}

const STATE_COLORS: Record<string, string> = {
  operational: '#22c55e',
  degraded: '#f59e0b',
  partial_outage: '#f97316',
  major_outage: '#ef4444',
  maintenance: '#6d5dfc',
};

const BAR_HEIGHT = 34;
const BAR_GAP = 1;

export function UptimeBar({ days, uptimePercent }: UptimeBarProps) {
  const barCount = days.length;
  if (barCount === 0) return null;

  // Each bar is 3px wide with 1px gap
  const barWidth = 3;
  const totalWidth = barCount * (barWidth + BAR_GAP) - BAR_GAP;

  return (
    <div className="flex flex-col gap-1.5">
      <svg
        width="100%"
        height={BAR_HEIGHT}
        viewBox={`0 0 ${String(totalWidth)} ${String(BAR_HEIGHT)}`}
        preserveAspectRatio="none"
        className="rounded-[2px]"
        aria-label={`${String(uptimePercent)}% uptime over ${String(barCount)} days`}
        role="img"
      >
        {days.map((day, i) => {
          const color = STATE_COLORS[day.state] ?? '#22c55e';
          return (
            <rect
              key={day.date}
              x={i * (barWidth + BAR_GAP)}
              y={0}
              width={barWidth}
              height={BAR_HEIGHT}
              fill={color}
              rx={1}
            >
              <title>{`${day.date}: ${day.state} (${String(day.uptimePercent)}%)`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="flex items-center justify-between text-xs text-[var(--color-muted)]">
        <span>{barCount} days ago</span>
        <span>{uptimePercent}% uptime</span>
        <span>Today</span>
      </div>
    </div>
  );
}
