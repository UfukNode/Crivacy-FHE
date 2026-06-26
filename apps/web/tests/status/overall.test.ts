/**
 * Overall status computation + grouping tests.
 */

import { describe, expect, it } from 'vitest';

import { computeOverallState, groupComponents, stateColor, stateLabel } from '@/lib/status/overall';
import type { PublicComponent } from '@/lib/status/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function comp(overrides: Partial<PublicComponent> = {}): PublicComponent {
  return {
    id: overrides.id ?? 'c1',
    slug: overrides.slug ?? 'api',
    name: overrides.name ?? 'API',
    description: 'description' in overrides ? (overrides.description ?? null) : null,
    group: 'group' in overrides ? (overrides.group ?? null) : 'core',
    state: overrides.state ?? 'operational',
    updatedAt: overrides.updatedAt ?? new Date('2026-04-12T00:00:00Z'),
  };
}

// ---------------------------------------------------------------------------
// computeOverallState
// ---------------------------------------------------------------------------

describe('computeOverallState', () => {
  it('returns operational for empty list', () => {
    expect(computeOverallState([])).toBe('operational');
  });

  it('returns operational when all operational', () => {
    const components = [comp(), comp({ id: 'c2', slug: 'ledger' })];
    expect(computeOverallState(components)).toBe('operational');
  });

  it('returns worst state across components', () => {
    const components = [
      comp({ state: 'operational' }),
      comp({ id: 'c2', state: 'degraded' }),
      comp({ id: 'c3', state: 'major_outage' }),
    ];
    expect(computeOverallState(components)).toBe('major_outage');
  });

  it('degraded wins over operational', () => {
    const components = [comp({ state: 'operational' }), comp({ id: 'c2', state: 'degraded' })];
    expect(computeOverallState(components)).toBe('degraded');
  });

  it('maintenance wins over partial_outage', () => {
    const components = [
      comp({ state: 'partial_outage' }),
      comp({ id: 'c2', state: 'maintenance' }),
    ];
    expect(computeOverallState(components)).toBe('maintenance');
  });
});

// ---------------------------------------------------------------------------
// groupComponents
// ---------------------------------------------------------------------------

describe('groupComponents', () => {
  it('returns empty array for empty input', () => {
    expect(groupComponents([])).toEqual([]);
  });

  it('groups by group field', () => {
    const components = [
      comp({ id: 'c1', group: 'core' }),
      comp({ id: 'c2', group: 'core' }),
      comp({ id: 'c3', group: 'delivery' }),
    ];
    const groups = groupComponents(components);
    expect(groups.length).toBe(2);
    expect(groups[0]?.groupName).toBe('core');
    expect(groups[0]?.components.length).toBe(2);
    expect(groups[1]?.groupName).toBe('delivery');
    expect(groups[1]?.components.length).toBe(1);
  });

  it('uses "Other" for null group', () => {
    const components = [comp({ id: 'c1', group: null })];
    const groups = groupComponents(components);
    expect(groups[0]?.groupName).toBe('Other');
  });

  it('preserves component order within group', () => {
    const components = [
      comp({ id: 'c1', name: 'Alpha', group: 'core' }),
      comp({ id: 'c2', name: 'Beta', group: 'core' }),
    ];
    const groups = groupComponents(components);
    expect(groups[0]?.components[0]?.name).toBe('Alpha');
    expect(groups[0]?.components[1]?.name).toBe('Beta');
  });
});

// ---------------------------------------------------------------------------
// stateLabel
// ---------------------------------------------------------------------------

describe('stateLabel', () => {
  it('returns human-readable label for each state', () => {
    expect(stateLabel('operational')).toBe('All Systems Operational');
    expect(stateLabel('degraded')).toBe('Degraded Performance');
    expect(stateLabel('partial_outage')).toBe('Partial System Outage');
    expect(stateLabel('major_outage')).toBe('Major System Outage');
    expect(stateLabel('maintenance')).toBe('Under Maintenance');
  });
});

// ---------------------------------------------------------------------------
// stateColor
// ---------------------------------------------------------------------------

describe('stateColor', () => {
  it('returns CSS variable for each state', () => {
    expect(stateColor('operational')).toBe('var(--color-success)');
    expect(stateColor('degraded')).toBe('var(--color-warning)');
    expect(stateColor('partial_outage')).toBe('var(--color-warning)');
    expect(stateColor('major_outage')).toBe('var(--color-danger)');
    expect(stateColor('maintenance')).toBe('var(--color-accent)');
  });
});
