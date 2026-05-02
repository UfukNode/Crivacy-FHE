/**
 * Public API for the security-events bus. Re-exports the emit-side
 * primitive (used inside state-changing transactions), the dispatcher
 * (consumed by the background worker + test harnesses), the built-in
 * subscribers, the bootstrap helper, and the payload schemas.
 */

export {
  emitSecurityEvent,
  type EmitSecurityEventInput,
  type EventSubjectKind,
  type SecurityEventType,
} from './emit';

export {
  MAX_DISPATCH_ATTEMPTS,
  __resetSecurityEventSubscribersForTest,
  dispatchPendingSecurityEvents,
  registerSecurityEventSubscriber,
  type DispatchInput,
  type DispatchResult,
  type SecurityEventEnvelope,
  type SecurityEventSubscriber,
  type SubscriberContext,
} from './dispatcher';

export {
  __resetSecurityEventBootstrapForTest,
  bootstrapSecurityEventSubscribers,
} from './bootstrap';

export { auditSubscriber, emailSubscriber } from './subscribers';

export {
  AuditContextPayload,
  PasswordChangeEventPayload,
} from './payload';
