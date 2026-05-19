/**
 * Handler barrel export.
 *
 * Route files import handlers from this barrel and wire them through
 * the appropriate middleware (apiRoute, publicRoute, webhookRoute).
 */

export {
  handleCancelSession,
  handleCreateSession,
  handleGetSession,
  handleListSessions,
} from './sessions';

export {
  handleGetCredential,
  handleGetCredentialHistory,
  handleVerifyCredential,
} from './credentials';

export {
  handleCreateWebhook,
  handleDeleteWebhook,
  handleGetWebhook,
  handleListDeliveries,
  handleListWebhooks,
  handleTestWebhook,
  handleUpdateWebhook,
} from './webhooks';

export { handleGetLimits, handleGetUsage, handleGetUsageHistory } from './usage';

export { handleHealthCheck, handleStatusCheck } from './health';
export type { StatusDeps } from './health';

export { handleDiditWebhook } from './didit-webhook';

// Dashboard (internal)
export {
  handleLogin,
  handleLogout,
  handleRefresh,
  handleTotpSetup,
  handleTotpVerify,
} from './dashboard-auth';
export type {
  AuthHandlerDeps,
  LoginInput,
  LoginResult,
  RefreshInput,
  RefreshResult,
  TotpSetupResult,
  TotpVerifyInput,
} from './dashboard-auth';

export { handleGetFirmProfile, handleUpdateFirmProfile } from './dashboard-firm';
export type { FirmProfileDeps, FirmProfileResult, UpdateFirmInput } from './dashboard-firm';

export {
  handleCreateApiKey,
  handleDeleteApiKey,
  handleListApiKeys,
  handleRotateApiKey,
} from './dashboard-keys';
export type { ApiKeyDeps, CreateApiKeyInput, CreateApiKeyResult } from './dashboard-keys';

export { handleGetUsageChart } from './dashboard-usage';
export type { UsageChartDeps, UsageChartResult } from './dashboard-usage';

export {
  handleListDeliveries as handleListDashboardDeliveries,
  handleReplayDelivery,
  handleDashboardListWebhooks,
  handleDashboardCreateWebhook,
  handleDashboardGetWebhook,
  handleDashboardUpdateWebhook,
  handleDashboardDeleteWebhook,
} from './dashboard-webhooks';
export type {
  WebhookDeliveryDeps,
  DeliveryListResult,
  DashboardWebhookListResult,
  DashboardWebhookMutationResult,
} from './dashboard-webhooks';

export { handleListAuditEntries } from './dashboard-audit';
export type { AuditLogDeps, AuditListResult } from './dashboard-audit';

export { handlePlaygroundExecute } from './dashboard-playground';
export type {
  PlaygroundDeps,
  PlaygroundExecuteInput,
  PlaygroundExecuteResult,
} from './dashboard-playground';

// Admin (internal)
export { handleAdminLogin, handleAdminLogout, handleAdminRefresh } from './admin-auth';
export type {
  AdminAuthHandlerDeps,
  AdminLoginInput,
  AdminLoginResult,
  AdminRefreshInput,
  AdminRefreshResult,
} from './admin-auth';

export {
  handleListFirms,
  handleGetFirm,
  handleCreateFirm,
  handleUpdateFirm,
  handleSoftDeleteFirm,
  handleRestoreFirm,
  handleGetAdminFirmDetail,
  handleAdminUnlockFirmUser,
} from './admin-firms';
export {
  handleValidateFirmInvite,
  handleAcceptFirmInvite,
} from './firm-invite';
export {
  handleListFirmTicketCategories,
  handleListFirmTickets,
  handleCreateFirmTicket,
  handleGetFirmTicket,
  handleAddFirmMessage,
  handleEditFirmMessage,
} from './firm-tickets';
export {
  handleListFirmTeam,
  handleInviteFirmTeammate,
  handleChangeFirmUserRole,
  handleRemoveFirmTeammate,
} from './firm-team';
export type {
  ValidateFirmInviteResult,
  AcceptFirmInviteInput,
  AcceptFirmInviteResult,
  AcceptFirmInviteDeps,
} from './firm-invite';
export type {
  AdminFirmsDeps,
  CreateFirmInput,
  UpdateFirmInput as AdminUpdateFirmInput,
} from './admin-firms';

export {
  handleListComponents,
  handleCreateComponent,
  handleUpdateComponent,
  handleListIncidents,
  handleCreateIncident,
  handleUpdateIncident,
  handleAddTimelineUpdate,
} from './admin-status';
export type { AdminStatusDeps, CreateComponentInput, CreateIncidentInput } from './admin-status';

export { handleGetSystemMetrics } from './admin-system';
export type { AdminSystemDeps, SystemMetrics } from './admin-system';

export { handleListGlobalAudit } from './admin-audit';
export type { AdminAuditDeps, ListGlobalAuditInput, ListGlobalAuditResult } from './admin-audit';

// Customer KYC (customer-facing)
export {
  handleGetKycStatus,
  handleStartIdentity,
  handleStartAddress,
  handleGetSession as handleGetCustomerKycSession,
  handleResumeSession,
  handleGetCredential as handleGetCustomerCredential,
  handleKycEvents,
} from './customer-kyc';
