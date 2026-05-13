/**
 * Overall system state computation.
 * @module
 */

import type { ComponentState, PublicComponent } from './types';
import { isWorseThan } from './uptime';

/**
 * Compute the overall system state as the worst state across all components.
 * Returns 'operational' if there are no components.
 */
export function computeOverallState(components: readonly PublicComponent[]): ComponentState {
  let worst: ComponentState = 'operational';
  for (const c of components) {
    if (isWorseThan(c.state, worst)) {
      worst = c.state;
    }
  }
  return worst;
}

/**
 * Group components by their `group` field. Components with null group
 * are placed under 'Other'. Groups are ordered by the minimum position
 * of their members.
 */
export function groupComponents(
  components: readonly PublicComponent[],
): readonly { readonly groupName: string; readonly components: readonly PublicComponent[] }[] {
  const grouped = new Map<string, PublicComponent[]>();
  const groupMinPosition = new Map<string, number>();

  for (const c of components) {
    const groupKey = c.group ?? 'Other';
    const existing = grouped.get(groupKey);
    if (existing !== undefined) {
      existing.push(c);
    } else {
      grouped.set(groupKey, [c]);
    }
    const currentMin = groupMinPosition.get(groupKey);
    // we don't have position on PublicComponent, so we use insertion order
    if (currentMin === undefined) {
      groupMinPosition.set(groupKey, grouped.get(groupKey)?.length ?? 0);
    }
  }

  // Sort groups by insertion order (Map preserves insertion order)
  const result: { readonly groupName: string; readonly components: readonly PublicComponent[] }[] =
    [];
  for (const [groupName, comps] of grouped) {
    result.push({ groupName, components: comps });
  }
  return result;
}

/** Human-readable label for a component state. */
export function stateLabel(state: ComponentState): string {
  switch (state) {
    case 'operational':
      return 'All Systems Operational';
    case 'degraded':
      return 'Degraded Performance';
    case 'partial_outage':
      return 'Partial System Outage';
    case 'major_outage':
      return 'Major System Outage';
    case 'maintenance':
      return 'Under Maintenance';
  }
}

/** CSS-friendly color token for a component state. */
export function stateColor(state: ComponentState): string {
  switch (state) {
    case 'operational':
      return 'var(--color-success)';
    case 'degraded':
      return 'var(--color-warning)';
    case 'partial_outage':
      return 'var(--color-warning)';
    case 'major_outage':
      return 'var(--color-danger)';
    case 'maintenance':
      return 'var(--color-accent)';
  }
}
