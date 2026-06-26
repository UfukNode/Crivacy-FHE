/**
 * Uptime computation tests — pure functions, no DB.
 */

import { describe, expect, it } from 'vitest';

import type { ComponentState, DayStatus, HistoryEntry } from '@/lib/status/types';
import {
  UPTIME_DAYS,
  buildDateRange,
  buildUptimeSummary,
  computeDailyStatuses,
  computeOverallUptime,
  formatUtcDate,
  isWorseThan,
} from '@/lib/status/uptime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-12T12:00:00Z');

function entry(state: ComponentState, dateStr: string, hour = 10): HistoryEntry {
  return {
    componentId: 'comp-1',
    state,
    ts: new Date(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`),
  };
}

// ---------------------------------------------------------------------------
// formatUtcDate
// ---------------------------------------------------------------------------

describe('formatUtcDate', () => {
  it('formats a date as YYYY-MM-DD', () => {
    expect(formatUtcDate(new Date('2026-04-12T15:30:00Z'))).toBe('2026-04-12');
  });

  it('handles midnight boundary', () => {
    expect(formatUtcDate(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
  });

  it('handles year-end', () => {
    expect(formatUtcDate(new Date('2025-12-31T23:59:59Z'))).toBe('2025-12-31');
  });
});

// ---------------------------------------------------------------------------
// buildDateRange
// ---------------------------------------------------------------------------

describe('buildDateRange', () => {
  it('returns UPTIME_DAYS entries by default', () => {
    const range = buildDateRange(NOW);
    expect(range.length).toBe(UPTIME_DAYS);
  });

  it('ends with today', () => {
    const range = buildDateRange(NOW);
    expect(range[range.length - 1]).toBe('2026-04-12');
  });

  it('starts 89 days ago for 90-day window', () => {
    const range = buildDateRange(NOW, 90);
    // 89 days before 2026-04-12 = 2026-01-13
    expect(range[0]).toBe('2026-01-13');
  });

  it('returns 1 element for days=1', () => {
    const range = buildDateRange(NOW, 1);
    expect(range).toEqual(['2026-04-12']);
  });

  it('returns empty for days=0', () => {
    const range = buildDateRange(NOW, 0);
    expect(range).toEqual([]);
  });

  it('is sorted ascending', () => {
    const range = buildDateRange(NOW, 5);
    for (let i = 1; i < range.length; i++) {
      const prev = range[i - 1] ?? '';
      const curr = range[i] ?? '';
      expect(curr > prev).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// isWorseThan
// ---------------------------------------------------------------------------

describe('isWorseThan', () => {
  it('major_outage is worse than operational', () => {
    expect(isWorseThan('major_outage', 'operational')).toBe(true);
  });

  it('operational is NOT worse than degraded', () => {
    expect(isWorseThan('operational', 'degraded')).toBe(false);
  });

  it('same state is NOT worse', () => {
    expect(isWorseThan('degraded', 'degraded')).toBe(false);
  });

  it('maintenance is worse than partial_outage', () => {
    expect(isWorseThan('maintenance', 'partial_outage')).toBe(true);
  });

  it('degraded is worse than operational', () => {
    expect(isWorseThan('degraded', 'operational')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeDailyStatuses
// ---------------------------------------------------------------------------

describe('computeDailyStatuses', () => {
  it('returns all-operational for empty history', () => {
    const range = buildDateRange(NOW, 3);
    const result = computeDailyStatuses([], range);
    expect(result.length).toBe(3);
    for (const day of result) {
      expect(day.state).toBe('operational');
      expect(day.uptimePercent).toBe(100);
    }
  });

  it('carries forward state from previous day', () => {
    const range = buildDateRange(NOW, 3);
    // entry on first day, nothing on subsequent days
    const history: HistoryEntry[] = [entry('degraded', range[0] ?? '')];
    const result = computeDailyStatuses(history, range);
    expect(result[0]?.state).toBe('degraded');
    expect(result[1]?.state).toBe('degraded'); // carried forward
    expect(result[2]?.state).toBe('degraded'); // carried forward
  });

  it('picks worst state if multiple entries on same day', () => {
    const range = ['2026-04-12'];
    const history: HistoryEntry[] = [
      entry('operational', '2026-04-12', 8),
      entry('major_outage', '2026-04-12', 12),
      entry('operational', '2026-04-12', 18),
    ];
    const result = computeDailyStatuses(history, range);
    expect(result[0]?.state).toBe('major_outage');
    expect(result[0]?.uptimePercent).toBe(0);
  });

  it('uses last entry of day as carry-forward', () => {
    const range = ['2026-04-11', '2026-04-12'];
    const history: HistoryEntry[] = [
      entry('major_outage', '2026-04-11', 6),
      entry('operational', '2026-04-11', 18),
    ];
    const result = computeDailyStatuses(history, range);
    // Day 1: worst is major_outage
    expect(result[0]?.state).toBe('major_outage');
    // Day 2: carry-forward from last entry of day 1 = operational
    expect(result[1]?.state).toBe('operational');
  });

  it('uses pre-range history for initial state', () => {
    const range = ['2026-04-12'];
    const history: HistoryEntry[] = [
      entry('degraded', '2026-04-10'), // before range
    ];
    const result = computeDailyStatuses(history, range);
    expect(result[0]?.state).toBe('degraded');
  });

  it('maps states to approximate uptime percentages', () => {
    const range = ['2026-04-12'];
    const cases: [ComponentState, number][] = [
      ['operational', 100],
      ['degraded', 75],
      ['partial_outage', 50],
      ['major_outage', 0],
      ['maintenance', 50],
    ];
    for (const [state, expected] of cases) {
      const result = computeDailyStatuses([entry(state, '2026-04-12')], range);
      expect(result[0]?.uptimePercent).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// computeOverallUptime
// ---------------------------------------------------------------------------

describe('computeOverallUptime', () => {
  it('returns 100 for empty array', () => {
    expect(computeOverallUptime([])).toBe(100);
  });

  it('returns 100 for all-operational', () => {
    const days: DayStatus[] = [
      { date: '2026-04-10', state: 'operational', uptimePercent: 100 },
      { date: '2026-04-11', state: 'operational', uptimePercent: 100 },
      { date: '2026-04-12', state: 'operational', uptimePercent: 100 },
    ];
    expect(computeOverallUptime(days)).toBe(100);
  });

  it('averages across days', () => {
    const days: DayStatus[] = [
      { date: '2026-04-10', state: 'operational', uptimePercent: 100 },
      { date: '2026-04-11', state: 'major_outage', uptimePercent: 0 },
    ];
    expect(computeOverallUptime(days)).toBe(50);
  });

  it('rounds to 2 decimal places', () => {
    const days: DayStatus[] = [
      { date: '2026-04-10', state: 'operational', uptimePercent: 100 },
      { date: '2026-04-11', state: 'operational', uptimePercent: 100 },
      { date: '2026-04-12', state: 'degraded', uptimePercent: 75 },
    ];
    // (100 + 100 + 75) / 3 = 91.666...
    expect(computeOverallUptime(days)).toBe(91.67);
  });
});

// ---------------------------------------------------------------------------
// buildUptimeSummary
// ---------------------------------------------------------------------------

describe('buildUptimeSummary', () => {
  it('builds a complete summary', () => {
    const summary = buildUptimeSummary('comp-1', [], NOW);
    expect(summary.componentId).toBe('comp-1');
    expect(summary.days.length).toBe(UPTIME_DAYS);
    expect(summary.uptimePercent).toBe(100);
  });

  it('reflects history in the summary', () => {
    const history: HistoryEntry[] = [entry('major_outage', '2026-04-12', 8)];
    const summary = buildUptimeSummary('comp-1', history, NOW);
    const lastDay = summary.days[summary.days.length - 1];
    expect(lastDay?.state).toBe('major_outage');
    expect(lastDay?.uptimePercent).toBe(0);
    // Overall should be less than 100
    expect(summary.uptimePercent).toBeLessThan(100);
  });

  it('supports custom day count', () => {
    const summary = buildUptimeSummary('comp-1', [], NOW, 7);
    expect(summary.days.length).toBe(7);
  });
});
