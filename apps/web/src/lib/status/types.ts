/**
 * Status page business-logic types.
 * @module
 */

/** Component state severity weight — lower is better. */
export const STATE_SEVERITY_ORDER = Object.freeze({
  operational: 0,
  degraded: 1,
  partial_outage: 2,
  major_outage: 3,
  maintenance: 4,
} as const);

export type ComponentState = keyof typeof STATE_SEVERITY_ORDER;

export const COMPONENT_STATES: readonly ComponentState[] = Object.freeze(
  Object.keys(STATE_SEVERITY_ORDER) as ComponentState[],
);

/** Single day in the 90-day uptime bar. */
export interface DayStatus {
  readonly date: string; // 'YYYY-MM-DD'
  readonly state: ComponentState;
  /** Uptime percentage for the day (0-100). */
  readonly uptimePercent: number;
}

/** 90-day uptime summary for a single component. */
export interface UptimeSummary {
  readonly componentId: string;
  readonly days: readonly DayStatus[];
  /** Overall uptime percentage across the 90-day window. */
  readonly uptimePercent: number;
}

/** State change record from status_history table. */
export interface HistoryEntry {
  readonly componentId: string;
  readonly state: ComponentState;
  readonly ts: Date;
}

/** Public component view. */
export interface PublicComponent {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly group: string | null;
  readonly state: ComponentState;
  readonly updatedAt: Date;
}

/** Public incident view. */
export interface PublicIncident {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: 'minor' | 'major' | 'critical';
  readonly status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  readonly componentIds: readonly string[];
  readonly startedAt: Date;
  readonly identifiedAt: Date | null;
  readonly monitoringAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly updates: readonly TimelineEntry[];
}

/** Single timeline entry inside an incident. */
export interface TimelineEntry {
  readonly at: string;
  readonly status: string;
  readonly body: string;
}

/** Grouped components for display. */
export interface ComponentGroup {
  readonly groupName: string;
  readonly components: readonly PublicComponent[];
}

/** Full status page data. */
export interface StatusPageData {
  readonly overall: ComponentState;
  readonly groups: readonly ComponentGroup[];
  readonly incidents: readonly PublicIncident[];
  readonly uptimes: ReadonlyMap<string, UptimeSummary>;
  readonly generatedAt: Date;
}
