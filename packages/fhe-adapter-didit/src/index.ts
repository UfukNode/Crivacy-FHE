/**
 * Public surface of `@crivacy-fhe/adapter-didit`.
 *
 * Importers should reach for this module, not the individual files
 * underneath it. The internal layout (errors → types → config →
 * canonical → schemas → http → session → webhook → mapping → client)
 * is free to change without breaking consumers as long as the
 * exports below stay stable.
 *
 * The layering discipline matches `@credential/core`: errors / types /
 * config first, then the transport + domain modules, then the
 * facade. Every identifier below is used at least once outside the
 * package — there are no "export everything, just in case" leaks.
 */

/* ---------- Errors ---------- */
export { DiditError, isDiditError, isDiditErrorWithCode } from './errors';
export type { DiditErrorCode } from './errors';

/* ---------- Types ---------- */
export {
  asDiditSessionIdUnchecked,
  asDiditVendorDataUnchecked,
  asDiditWorkflowIdUnchecked,
  DIDIT_STATUS,
  DIDIT_DECISION_STATUSES,
  DIDIT_WORKFLOW_TYPES,
  INTERNAL_VERIFICATION_OUTCOMES,
} from './types';
export type {
  Brand,
  CreateSessionResult,
  DiditAddressFields,
  DiditDecisionPayload,
  DiditDecisionStatus,
  DiditFaceMatchFields,
  DiditKycDocumentFields,
  DiditLivenessFields,
  DiditSessionId,
  DiditVendorData,
  DiditVerificationFlags,
  DiditWorkflowId,
  DiditWorkflowType,
  InternalVerificationOutcome,
} from './types';

/* ---------- Config ---------- */
export {
  DiditConfigSchema,
  getDiditConfig,
  loadDiditConfig,
  resetDiditConfigForTests,
} from './config';
export type { DiditConfig, DiditConfigRaw, DiditEnv, DiditRequiredEnv } from './config';

/* ---------- Canonical JSON ---------- */
export { canonicalJson, shortenFloats, sortKeys } from './canonical';

/* ---------- Schemas ---------- */
export {
  AddressBlockSchema,
  CreateSessionResponseSchema,
  DecisionResponseSchema,
  DiditApiErrorSchema,
  FaceMatchBlockSchema,
  KycDocumentBlockSchema,
  LivenessBlockSchema,
  WebhookBodySchema,
} from './schemas';
export type {
  AddressBlock,
  CreateSessionResponse,
  DecisionResponse,
  DiditApiError,
  FaceMatchBlock,
  KycDocumentBlock,
  LivenessBlock,
  WebhookBody,
} from './schemas';

/* ---------- HTTP transport ---------- */
export { diditFetch, diditFetchOnce } from './http';
export type { DiditFetchOptions, FetchLike, FetchLikeResponse } from './http';

/* ---------- Session + decision ---------- */
export {
  MAX_VENDOR_DATA_LENGTH,
  createAddressSession,
  createKycSession,
  getDecision,
  hydrateDecisionFromWebhookBody,
  hydrateDecisionResponse,
  resolveWorkflowType,
  validateCallbackUrl,
  validateSessionId,
  validateVendorData,
  validateWorkflowId,
  workflowIdToType,
} from './session';
export type { ExpectedDetailsInput } from './session';

/* ---------- User entity (Sprint 8 — name anchor) ---------- */
export { getDiditUser, parseFullName } from './users';
export type { DiditUser, ParsedName } from './users';

/* ---------- Webhook ---------- */
export { parseWebhookBody, verifyWebhook } from './webhook';
export type { Clock, WebhookVerificationInput, WebhookVerificationResult } from './webhook';

/* ---------- Mapping + proof hash ---------- */
export {
  computeProofHash,
  detectWorkflowType,
  mergeVerificationFlags,
  reduceDecision,
  reduceOutcomes,
  statusToOutcome,
} from './mapping';
export type { MergedVerificationFlags } from './mapping';

/* ---------- Client facade ---------- */
export {
  buildDiditClientFromEnv,
  createDiditClient,
  getDiditClient,
  resetDiditClientForTests,
} from './client';
export type { DiditClient, DiditClientDeps } from './client';
