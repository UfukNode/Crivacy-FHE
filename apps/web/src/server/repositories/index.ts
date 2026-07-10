/**
 * Repository barrel export.
 *
 * Handlers import from this barrel; route files never touch repositories
 * directly.
 */

export { authLookup, buildAuthLookup } from './auth-lookup';

export {
  cancelSession,
  createSession,
  findActiveSessionByUserRef,
  findLinkedSession,
  findSessionById,
  listSessions,
  updateSessionStatus,
  type CreateSessionInput,
  type SessionListFilters,
  type SessionListResult,
} from './sessions';

export {
  createCredential,
  findCredentialByContractId,
  findCredentialByUserRef,
  findExpiredCredentialsToFlip,
  listCredentialHistory,
  updateCredentialStatus,
  type CreateCredentialInput,
} from './credentials';

export {
  countEndpointsByFirm,
  createDelivery,
  createEndpoint,
  createWebhookEvent,
  deleteEndpoint,
  findEndpointById,
  findEndpointsForEvent,
  findEndpointsForUserEvent,
  listDeliveries,
  listEndpoints,
  updateEndpoint,
  type CreateEndpointInput,
  type DeliveryWithEventType,
} from './webhooks';

export {
  getMonthlyUsageHistory,
  getUsageByEndpoint,
  getUsageForPeriod,
  getUsageTotals,
  recordUsageEvent,
} from './usage';

export {
  findFirmById as findFirmByIdForDashboard,
  findFirmByIdForMiddleware,
  findFirmProfile,
  findFirmSettings,
  findFirmUserByIdForMiddleware,
  findSessionByJti,
  findSessionByJtiForMiddleware,
  findUserByEmail,
  countActiveApiKeysByFirm,
  findUserById as findUserByIdForDashboard,
  incrementFailedLoginOrLock,
  insertApiKey,
  insertSession as insertDashboardSession,
  listApiKeys,
  listAuditEntries,
  listDashboardDeliveries,
  findApiKeyCreatorId,
  replayDelivery,
  resetFailedLogin,
  revokeApiKey,
  revokeAllDashboardSessions,
  revokeSession as revokeDashboardSession,
  rotateApiKey,
  saveTotpSecret,
  updateFirm,
  getFirmOnchainAddress,
  setFirmOnchainAddress,
  updateSessionAfterRotate,
  findApiKeyForPlayground,
  resolveApiKeyByIdForPlayground,
} from './dashboard';

// Status (public)
export {
  confirmSubscription,
  listActiveSubscribers,
  listHistoryForUptime,
  listPublicComponents,
  listPublicIncidents,
  subscribeEmail,
  unsubscribeByToken,
  type HistoryRow,
  type PublicComponentRow,
  type PublicIncidentRow,
  type SubscribeResult,
} from './status';

// Admin
export {
  findAdminUserByEmail,
  findAdminLoginUserById,
  findAdminUserByIdForMiddleware,
  findAdminSessionByJtiForMiddleware,
  insertAdminSession,
  revokeAdminSession,
  revokeAllAdminSessions,
  incrementAdminFailedLoginOrLock,
  resetAdminFailedLogin,
  listFirmsForAdmin,
  getFirmForAdmin,
  createFirmForAdmin,
  updateFirmForAdmin,
  softDeleteFirmForAdmin,
  restoreFirmForAdmin,
  listStatusComponentsForAdmin,
  createStatusComponent,
  updateStatusComponentForAdmin,
  listStatusIncidentsForAdmin,
  createStatusIncident,
  updateStatusIncident,
  addIncidentTimelineUpdate,
  listGlobalAuditEntries,
  getSystemMetrics,
} from './admin';

// Admin login challenges (two-step login)
export {
  generateChallengeToken,
  hashChallengeToken,
  createAdminLoginChallenge,
  findValidAdminLoginChallenge,
  incrementChallengeTotpAttempts,
  markChallengeUsed,
  cleanupExpiredChallenges,
  MAX_TOTP_ATTEMPTS_PER_CHALLENGE,
} from './admin-challenges';
export type { AdminLoginChallengeRow } from './admin-challenges';

// OAuth / OIDC
export {
  countOauthClientsByFirm,
  findOauthClientByClientId,
  findOauthClientById,
  listOauthClientsForFirm,
  insertOauthClient,
  insertAuthorizationRequest,
  findAuthorizationRequest,
  attachUserToAuthorizationRequest,
  markAuthorizationRequestCompleted,
  insertAuthorizationCode,
  findAuthorizationCode,
  burnAuthorizationCode,
  revokeTokensMintedFromCode,
  findActiveConsent,
  listConsentsForUser,
  insertConsent,
  touchConsent,
  revokeConsent,
  insertAccessToken,
  findAccessToken,
  touchAccessToken,
  revokeAccessToken,
  deleteExpiredAuthorizationRequests,
  deleteExpiredAuthorizationCodes,
} from './oauth';
