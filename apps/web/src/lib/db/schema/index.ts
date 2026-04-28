/**
 * `@/lib/db/schema` barrel — the ONLY path that Drizzle Kit, the runtime
 * client factory, and application code are allowed to import from. Keeping
 * the surface flat lets us rename the underlying schema files later
 * without having to sweep the whole repo.
 *
 * If a new schema module is added under this directory, re-export it here
 * AND add its tables to the `tests/db/schema.test.ts` coverage set so the
 * Step 3 shape test fails until documentation and migrations are updated.
 */

export * from './enums';
export * from './firms';
export * from './users';
export * from './api-keys';
export * from './rate-limit';
export * from './usage';
export * from './kyc';
export * from './webhooks';
export * from './customers';
export * from './audit';
export * from './rbac';
export * from './status';
// Sprint 7 Phase H — `./customer-kyc` removed; `kycDeviceHandoffs`
// moved into `./kyc`, and `customer_kyc_sessions` table dropped from
// the database. The unified `kyc_sessions` (in `./kyc`) is the sole
// source of truth for both customer and B2B KYC sessions.
export * from './customer-blacklist';
export * from './ip-abuse-signals';
export * from './notifications';
export * from './notification-preferences';
export * from './tickets';
export * from './ticket-participants';
export * from './ticket-message-mentions';
export * from './ticket-category-admins';
export * from './customer-linked-accounts';
export * from './wallet-nonces-used';
export * from './admin-login-challenges';
export * from './auth-rate-limit';
export * from './firm-user-invites';
export * from './firm-user-password-reset-tokens';
export * from './firm-user-recovery-codes';
export * from './admin-user-recovery-codes';
export * from './idempotency-keys';
export * from './security-events-outbox';
export * from './oauth-clients';
export * from './oauth-authorization-requests';
export * from './oauth-authorization-codes';
export * from './oauth-consents';
export * from './oauth-access-tokens';
