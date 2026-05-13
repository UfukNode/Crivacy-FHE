/**
 * Status page business-logic module.
 * @module
 */

export type {
  ComponentGroup,
  ComponentState,
  DayStatus,
  HistoryEntry,
  PublicComponent,
  PublicIncident,
  StatusPageData,
  TimelineEntry,
  UptimeSummary,
} from './types';

export { COMPONENT_STATES, STATE_SEVERITY_ORDER } from './types';

export {
  buildDateRange,
  buildUptimeSummary,
  computeDailyStatuses,
  computeOverallUptime,
  formatUtcDate,
  isWorseThan,
  UPTIME_DAYS,
} from './uptime';

export { computeOverallState, groupComponents, stateColor, stateLabel } from './overall';
