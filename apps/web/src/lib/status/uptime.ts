/**
 * Uptime computation from status_history entries.
 *
 * Pure functions — no DB access. Tested without infrastructure.
 * @module
 */

import type { ComponentState, DayStatus, HistoryEntry, UptimeSummary } from './types';
import { STATE_SEVERITY_ORDER } from './types';

/** Number of days to include in the uptime bar. */
export const UPTIME_DAYS = 90;

/** Milliseconds in a UTC day. */
const MS_PER_DAY = 86_400_000;

/**
 * Return 'YYYY-MM-DD' for a Date in UTC.
 */
export function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Build the list of dates for the last `days` UTC days ending at `today`.
 */
export function buildDateRange(today: Date, days: number = UPTIME_DAYS): readonly string[] {
  const result: string[] = [];
  const todayStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayStart.getTime() - i * MS_PER_DAY);
    result.push(formatUtcDate(d));
  }
  return result;
}

/**
 * Given a sorted (ascending by ts) history for a single component,
 * compute the per-day status for the given date range.
 *
 * Algorithm:
 *   - Walk through the date range.
 *   - For each day, find all history entries within that UTC day.
 *   - The day's state is the WORST state seen during that day.
 *   - If no entries fall on that day, carry forward the last known state.
 *   - If no entries exist before a day, assume 'operational'.
 *   - Uptime% = fraction of the day the component was 'operational'.
 *     For simplicity, if the worst state of the day is 'operational', 100%.
 *     If any non-operational state is seen, we compute weighted time fractions.
 */
export function computeDailyStatuses(
  history: readonly HistoryEntry[],
  dateRange: readonly string[],
): readonly DayStatus[] {
  // We'll use a simpler model: the day state is the worst state seen,
  // and uptime% is 100 if operational all day, 0 if major_outage, proportional otherwise.
  let lastKnownState: ComponentState = 'operational';
  const result: DayStatus[] = [];

  // Pre-index history entries by date
  const entriesByDate = new Map<string, HistoryEntry[]>();
  for (const entry of history) {
    const dateKey = formatUtcDate(entry.ts);
    const existing = entriesByDate.get(dateKey);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      entriesByDate.set(dateKey, [entry]);
    }
  }

  // Find the last state before the range starts
  const rangeStartDate = dateRange[0];
  if (rangeStartDate !== undefined) {
    for (const entry of history) {
      if (formatUtcDate(entry.ts) < rangeStartDate) {
        lastKnownState = entry.state;
      } else {
        break;
      }
    }
  }

  for (const date of dateRange) {
    const dayEntries = entriesByDate.get(date);
    if (dayEntries === undefined || dayEntries.length === 0) {
      // No changes this day — carry forward
      result.push({
        date,
        state: lastKnownState,
        uptimePercent: lastKnownState === 'operational' ? 100 : stateToUptime(lastKnownState),
      });
    } else {
      // Find worst state this day (including carry-forward)
      let worstState = lastKnownState;
      for (const entry of dayEntries) {
        if (isWorseThan(entry.state, worstState)) {
          worstState = entry.state;
        }
        // The last entry of the day becomes the carry-forward
        lastKnownState = entry.state;
      }
      result.push({
        date,
        state: worstState,
        uptimePercent: stateToUptime(worstState),
      });
    }
  }

  return result;
}

/**
 * Compute the overall uptime percentage from daily statuses.
 * Simple average of daily uptimePercent.
 */
export function computeOverallUptime(days: readonly DayStatus[]): number {
  if (days.length === 0) return 100;
  const sum = days.reduce((acc, d) => acc + d.uptimePercent, 0);
  return Math.round((sum / days.length) * 100) / 100;
}

/**
 * Build a full UptimeSummary for a single component.
 */
export function buildUptimeSummary(
  componentId: string,
  history: readonly HistoryEntry[],
  today: Date,
  days: number = UPTIME_DAYS,
): UptimeSummary {
  const dateRange = buildDateRange(today, days);
  const dailyStatuses = computeDailyStatuses(history, dateRange);
  return {
    componentId,
    days: dailyStatuses,
    uptimePercent: computeOverallUptime(dailyStatuses),
  };
}

/** Is `a` worse (higher severity) than `b`? */
export function isWorseThan(a: ComponentState, b: ComponentState): boolean {
  return STATE_SEVERITY_ORDER[a] > STATE_SEVERITY_ORDER[b];
}

/** Map a component state to an approximate uptime percentage for that day. */
function stateToUptime(state: ComponentState): number {
  switch (state) {
    case 'operational':
      return 100;
    case 'degraded':
      return 75;
    case 'partial_outage':
      return 50;
    case 'major_outage':
      return 0;
    case 'maintenance':
      return 50;
  }
}
