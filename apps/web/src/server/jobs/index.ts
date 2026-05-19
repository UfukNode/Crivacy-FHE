/**
 * Server jobs — barrel export.
 *
 * @module
 */

// Queue
export {
  WEBHOOK_DELIVERY_QUEUE,
  createQueueClient,
  enqueueDeliveries,
  enqueueDelivery,
} from './queue';
export type { WebhookDeliveryJob } from './queue';

// Worker
export { processDelivery, registerWebhookWorker } from './webhook-worker';
export type {
  DeliveryRow,
  EndpointRow,
  EventRow,
  WorkerDeps,
  WorkerRepository,
} from './webhook-worker';

// Repository
export { buildWorkerRepository } from './webhook-repository';

// Security events outbox worker
export {
  SECURITY_EVENTS_QUEUE,
  registerSecurityEventsWorker,
} from './security-events-worker';
export type { SecurityEventsWorkerDeps } from './security-events-worker';

// Idempotency sweeper worker
export {
  IDEMPOTENCY_SWEEPER_QUEUE,
  registerIdempotencySweeperWorker,
} from './idempotency-sweeper-worker';
export type { IdempotencySweeperDeps } from './idempotency-sweeper-worker';

// IP-abuse pruner worker (Sprint 6 — daily TTL sweep on
// `ip_abuse_signals`).
export {
  IP_ABUSE_PRUNER_QUEUE,
  registerIpAbusePrunerWorker,
} from './ip-abuse-pruner-worker';
export type { IpAbusePrunerDeps } from './ip-abuse-pruner-worker';

// KYC reconciler worker (Sprint 3 — drift sweep when neither webhook
// nor SSE pull-fallback landed; reads Didit live + replays the
// pipeline through the same enqueue path the webhook uses).
export {
  KYC_RECONCILER_QUEUE,
  registerKycReconcilerWorker,
  loadKycReconcilerConfig,
  runReconciliationCycle,
  reconcileCustomer,
  findDriftCandidates,
  buildThrottle,
  createFailureStreakCounter,
  createNoopFailureStreakCounter,
} from './kyc-reconciler-worker';
export type {
  KycReconcilerWorkerDeps,
  KycReconcilerConfig,
  FailureStreakCounter,
} from './kyc-reconciler-worker';
