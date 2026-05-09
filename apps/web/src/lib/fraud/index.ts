/**
 * `@/lib/fraud` barrel — fraud detection, classification, blacklist
 * operations, and ban orchestration.
 *
 * @module
 */

export type { FraudReason } from './types';

export {
  classifyDecision,
  extractFraudSignals,
  pickFraudReason,
  type FraudClassification,
  type FraudSignal,
} from './classify';

export {
  addToBlacklist,
  hashDocument,
  hashEmail,
  hashFace,
  hashWalletAddress,
  isBlacklisted,
  isFaceBlacklisted,
  isWalletBlacklisted,
  listBlacklist,
  removeFromBlacklist,
  type AddToBlacklistInput,
} from './blacklist';

export {
  banCustomer,
  revokeActiveCredentials,
  type BanCustomerInput,
  type BanResult,
} from './ban';

export {
  cascadeBan,
  type CascadeBanContext,
  type CascadeBanInput,
  type CascadeBanResult,
} from './cascade-ban';

export {
  evaluateFaceMatch,
  maskEmail,
  parseMatchVendorData,
  type FaceMatchContext,
  type FaceMatchEvaluation,
  type FaceMatchLookup,
  type MatchedAccountStatus,
  type ResolvedMatch,
} from './face-match';

export {
  createFaceMatchLookup,
  findCascadeMatchByFaceHash,
} from './face-match-lookup';

export {
  applyFaceMatchSideEffects,
  evaluateFaceMatchFromDecision,
  type ApplyFaceMatchSideEffectsParams,
  type FaceMatchEvaluationResult,
  type FaceMatchSurface,
} from './face-match-dispatch';

export {
  KYC_DECLINE_DEFAULT_THRESHOLD,
  KYC_DECLINE_DEFAULT_COOLDOWN_HOURS,
  evaluateDeclineLock,
  incrementDecline,
  resetDecline,
  getDeclineState,
  type DeclineLockState,
  type IncrementDeclineParams,
  type IncrementDeclineResult,
} from './decline-counter';
