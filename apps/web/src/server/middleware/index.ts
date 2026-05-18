/**
 * Middleware barrel — re-exports every route builder, parser, and
 * error mapper so handler files can import from a single path:
 *
 *   import { apiRoute, parseBody, publicRoute } from '@/server/middleware';
 */

export { apiRoute } from './api-route';
export type {
  ApiHandler,
  ApiRouteOptions,
  AuthLookupFn,
  RateLimitDecision,
  RateLimitFn,
} from './api-route';

export { mapErrorToResponse, isMappedError } from './error-mapper';
export type { MappedError } from './error-mapper';

export {
  parseBody,
  parseJsonBody,
  parseQuery,
  parsePathParams,
  ParseError,
  isParseError,
} from './parse';

export { publicRoute } from './public-route';
export type { PublicHandler } from './public-route';

export { webhookRoute } from './webhook-route';
export type { WebhookHandler, WebhookInput } from './webhook-route';

export { dashboardRoute, extractToken, meetsRoleRequirement } from './dashboard-route';
export type {
  DashboardHandler,
  DashboardRole,
  DashboardRouteOptions,
  FirmLookupFn,
  FirmUserLookupFn,
  FirmUserRow,
  SessionLookupFn,
  SessionRow,
} from './dashboard-route';

export {
  adminRoute,
  extractAdminToken,
  meetsAdminRoleRequirement,
  checkIpAllowlist,
} from './admin-route';
export type {
  AdminHandler,
  AdminRole,
  AdminRouteOptions,
  AdminSessionLookupFn,
  AdminSessionRow,
  AdminUserLookupFn,
  AdminUserRow,
} from './admin-route';
