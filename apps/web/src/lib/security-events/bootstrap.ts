/**
 * Security-events bootstrap — one-shot wiring that registers every
 * built-in subscriber.
 *
 * Called once during application startup (or worker startup) BEFORE
 * the dispatcher runs. Subscribers are module-scoped (see
 * `dispatcher.ts`) so registering them multiple times in the same
 * process would duplicate every side effect; the `bootstrapped`
 * flag guards against that when test harnesses accidentally call
 * this twice.
 *
 * @module
 */

import {
  __resetSecurityEventSubscribersForTest,
  registerSecurityEventSubscriber,
} from './dispatcher';
import { auditSubscriber, emailSubscriber } from './subscribers';

let bootstrapped = false;

/**
 * Register the built-in subscribers (audit + email). Idempotent
 * inside a single process — repeated calls are a no-op.
 *
 * This is intentionally separate from the dispatcher itself because
 * tests often want to register custom subscribers and skip the built-
 * ins, or the reverse. Production callers always use this function.
 */
export function bootstrapSecurityEventSubscribers(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  registerSecurityEventSubscriber(auditSubscriber);
  registerSecurityEventSubscriber(emailSubscriber);
}

/**
 * Test-only — reset the bootstrap flag + clear registered
 * subscribers. Never call this from app code.
 */
export function __resetSecurityEventBootstrapForTest(): void {
  bootstrapped = false;
  __resetSecurityEventSubscribersForTest();
}
