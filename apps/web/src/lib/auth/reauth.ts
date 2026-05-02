/**
 * Step-up reauthentication gate — unified across customer / firm /
 * admin audiences.
 *
 * Every state-changing settings endpoint needs the same two questions
 * answered before committing: does the caller still own the password,
 * and (when the action is sensitive enough to warrant it) do they also
 * still own the second factor the account is protected by? The pattern
 * was previously hand-rolled inline in each endpoint — with subtly
 * different strictness: the firm-side `totp/replace` handler forgot to
 * ask for the current TOTP code (see H1 in the Phase 0 audit), the
 * customer-side flows mix wallet-signature and password gates under
 * different conditions, and admin didn't have a path at all yet.
 *
 * This module collapses the five code paths into one primitive. The
 * caller declares:
 *
 *   - `subject` — which audience + ID (`customer` | `firm` | `admin`)
 *   - `password` — the current password submitted by the user
 *   - `factor`  — what second factor (if any) to demand proof of:
 *       * `none`           — password-only (change-password, low-risk ops)
 *       * `totp`           — plus a current 6-8 digit authenticator code
 *       * `recovery_code`  — plus a one-time backup code (burnt atomically)
 *       * `wallet`         — plus a fresh Ethereum wallet signature
 *                            (customer-only, email-less step-up chain)
 *
 * Output is a discriminated union (`ok` | `failed` with `reason`).
 * There is no shortcut where "password wrong" and "factor wrong" are
 * collapsed — the caller may want to surface them differently (e.g.
 * the factor mismatch triggers an inline "try recovery code?" link
 * while password mismatch bumps a failed-login counter).
 *
 * Invariants enforced here:
 *
 *   1. The password hash is fetched on every call (never trusted from
 *      session state) so a compromise that only has a session cookie
 *      cannot satisfy this gate.
 *   2. Recovery-code redemption is a single `UPDATE ... RETURNING`
 *      with `WHERE used_at IS NULL`, i.e. atomic burn-on-use — no
 *      TOCTOU between "is it valid?" and "mark used".
 *   3. Wallet nonce claims go through `claimWalletNonce`'s INSERT-
 *      ON-CONFLICT so a replayed signature loses the race.
 *   4. Unsupported factor × subject combinations (wallet on firm,
 *      TOTP on customer, recovery_code on customer, recovery_code on
 *      admin for now) return `factor_not_supported` without running
 *      any DB work — these combinations should never reach here, but
 *      the defensive branch protects against future misuse.
 *   5. Password-not-set (customers without a password on file) is a
 *      distinct outcome from wrong-password so the caller can emit a
 *      helpful "use set-password flow" response without leaking that
 *      state through a misleading 401.
 *
 * @module
 */

import { eq, sql } from 'drizzle-orm';

import type { AuthConfig } from '@/lib/auth/config';
import { decryptTotpSecret } from '@/lib/auth/decrypt-totp';
import { verifyPassword } from '@/lib/auth/password';
import { hashRecoveryCode } from '@/lib/auth/recovery-code';
import { verifyAndConsumeTotpCode } from '@/lib/auth/totp';
import {
  claimWalletNonce,
  verifyEvmWalletSignature,
  verifyWalletChallenge,
} from '@/lib/customer/evm-wallet';
import { findLinkedAccount } from '@/lib/customer/linked-accounts';
import type { CrivacyDatabase } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import type { ApiErrorCode } from '@/lib/openapi/common/errors';

/* -------------------------------------------------------------------------- */
/*  Subject + factor types                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Which authentication surface the caller lives on. Determines which
 * identity table the password + factor fields are read from.
 */
export type ReauthSubjectKind = 'customer' | 'firm' | 'admin';

export interface ReauthSubject {
  readonly kind: ReauthSubjectKind;
  readonly id: string;
}

/**
 * Proof the caller presents as their second factor. A callsite that
 * wants to accept multiple factor types (e.g. TOTP or recovery code)
 * picks the right variant based on which field the user populated in
 * the request body — this primitive handles one factor per call.
 */
export type ReauthFactor =
  | { readonly type: 'none' }
  | { readonly type: 'totp'; readonly code: string }
  | { readonly type: 'recovery_code'; readonly code: string }
  | {
      readonly type: 'wallet';
      readonly challenge: string;
      /** The EIP-4361 (SIWE) message the wallet signed. */
      readonly message: string;
      readonly signature: string;
    };

/**
 * Discriminated failure codes. Each maps to an HTTP error shape in the
 * route layer — see `lib/auth/errors.ts` for the user-facing mapping.
 */
export type ReauthReason =
  /** The subject has no password on file (e.g. wallet-only customer). */
  | 'password_not_set'
  /** Password submitted does not match the stored hash. */
  | 'wrong_password'
  /** The subject has no TOTP enrolled but a TOTP factor was demanded. */
  | 'totp_not_enrolled'
  /** TOTP code failed verification (wrong code / outside drift window). */
  | 'totp_invalid'
  /** Recovery code did not match any unused row for this subject. */
  | 'recovery_code_invalid'
  /** Wallet challenge JWT is missing, malformed, expired, or already burnt. */
  | 'wallet_challenge_invalid'
  /** Wallet signature did not verify OR signed by a wallet not linked here. */
  | 'wallet_signature_invalid'
  /** This factor type cannot be used for this subject kind. */
  | 'factor_not_supported';

export type ReauthResult =
  | {
      readonly status: 'ok';
      /**
       * Argon2id hash that the supplied password verified against. Returned so
       * downstream `UPDATE customers SET password_hash = ...` mutations can
       * include `WHERE password_hash = ${verifiedPasswordHash}` as a race
       * guard — without this, two concurrent change-password POSTs sharing
       * the same `currentPassword` both pass reauth and both UPDATE,
       * producing a last-write-wins outcome that violates the single-
       * password-change invariant. `null` for non-password subjects (e.g.
       * wallet-only customer reauthenticating via wallet signature without
       * a password on file — currently no such surface exists, but the
       * shape leaves room).
       */
      readonly verifiedPasswordHash: string | null;
    }
  | { readonly status: 'failed'; readonly reason: ReauthReason };

export interface ReauthInput {
  readonly db: CrivacyDatabase;
  readonly subject: ReauthSubject;
  readonly password: string;
  readonly factor: ReauthFactor;
  readonly now: Date;
  readonly authConfig: AuthConfig;
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Verify the caller still owns the account credentials required to
 * perform a sensitive operation.
 *
 * The function is safe to call without pre-checks: an unknown subject
 * ID resolves to `wrong_password` (no row, no hash, password verify
 * fails uniformly) rather than leaking a distinct error.
 */
export async function reauthGate(input: ReauthInput): Promise<ReauthResult> {
  switch (input.subject.kind) {
    case 'customer':
      return reauthCustomer(input);
    case 'firm':
      return reauthFirm(input);
    case 'admin':
      return reauthAdmin(input);
  }
}

/* -------------------------------------------------------------------------- */
/*  Customer branch                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Customer reauth: password + optional wallet signature.
 *
 * Customers do not (currently) have TOTP or recovery codes — the only
 * hardware-backed factor on this surface is the Ethereum wallet
 * for wallet-linked accounts. Submitting `factor.type === 'totp'` or
 * `'recovery_code'` against a customer returns `factor_not_supported`
 * without running any DB reads.
 */
async function reauthCustomer(input: ReauthInput): Promise<ReauthResult> {
  const row = await input.db
    .select({
      id: schema.customers.id,
      passwordHash: schema.customers.passwordHash,
    })
    .from(schema.customers)
    .where(eq(schema.customers.id, input.subject.id))
    .limit(1);

  const verifiedHash = row[0]?.passwordHash ?? null;
  const passwordStep = await checkPasswordStep(verifiedHash, input.password);
  if (passwordStep.status === 'failed') return passwordStep;

  switch (input.factor.type) {
    case 'none':
      return okWithHash(verifiedHash);
    case 'totp':
    case 'recovery_code':
      return fail('factor_not_supported');
    case 'wallet': {
      const walletResult = await verifyWalletFactor(input.db, input.subject.id, input.factor, input.now, input.authConfig);
      return walletResult.status === 'ok' ? okWithHash(verifiedHash) : walletResult;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Firm branch                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Firm user reauth: password + optional TOTP or recovery code.
 *
 * Firm users never have wallets linked — the wallet factor is a
 * customer-only concept, so `factor.type === 'wallet'` short-circuits
 * with `factor_not_supported`.
 */
async function reauthFirm(input: ReauthInput): Promise<ReauthResult> {
  const row = await input.db
    .select({
      id: schema.firmUsers.id,
      passwordHash: schema.firmUsers.passwordHash,
      totpSecretCiphertext: schema.firmUsers.totpSecretCiphertext,
      totpSecretNonce: schema.firmUsers.totpSecretNonce,
      totpKeyVersion: schema.firmUsers.totpKeyVersion,
      totpEnrolledAt: schema.firmUsers.totpEnrolledAt,
    })
    .from(schema.firmUsers)
    .where(eq(schema.firmUsers.id, input.subject.id))
    .limit(1);

  const record = row[0];
  const verifiedHash = record?.passwordHash ?? null;
  const passwordStep = await checkPasswordStep(verifiedHash, input.password);
  if (passwordStep.status === 'failed') return passwordStep;

  switch (input.factor.type) {
    case 'none':
      return okWithHash(verifiedHash);
    case 'totp': {
      if (
        record === undefined ||
        record.totpEnrolledAt === null ||
        record.totpSecretCiphertext === null ||
        record.totpSecretNonce === null ||
        record.totpKeyVersion === null
      ) {
        return fail('totp_not_enrolled');
      }
      const secret = decryptTotpSecret(
        record.totpSecretCiphertext,
        record.totpSecretNonce,
        record.totpKeyVersion,
        input.authConfig.totpEncryptionKey,
      );
      // BUG #54: replay-safe TOTP — same 6-digit code can't reauth
      // twice within the drift window. Critical for reauth because
      // it gates sensitive ops (credential creation, password change).
      const ok = await verifyAndConsumeTotpCode(
        input.db,
        input.subject.id,
        'firm',
        secret,
        input.factor.code,
        input.authConfig,
      );
      return ok ? okWithHash(verifiedHash) : fail('totp_invalid');
    }
    case 'recovery_code': {
      const result = await verifyFirmRecoveryCode(input.db, input.subject.id, input.factor.code, input.now);
      return result.status === 'ok' ? okWithHash(verifiedHash) : result;
    }
    case 'wallet':
      return fail('factor_not_supported');
  }
}

/**
 * Atomically burn a firm-user recovery code: `UPDATE ... SET used_at
 * WHERE firm_user_id = ... AND code_hash = ... AND used_at IS NULL
 * RETURNING id`. A returned row proves both that the code was valid
 * AND that we — not a concurrent redemption — consumed it.
 */
async function verifyFirmRecoveryCode(
  db: CrivacyDatabase,
  firmUserId: string,
  rawCode: string,
  now: Date,
): Promise<ReauthResult> {
  const codeHash = hashRecoveryCode(rawCode);
  const claimed = await db.execute<{ id: string }>(
    sql`UPDATE firm_user_recovery_codes
          SET used_at = ${now.toISOString()}
        WHERE firm_user_id = ${firmUserId}
          AND code_hash = ${codeHash}
          AND used_at IS NULL
        RETURNING id`,
  );
  return claimed.rows.length > 0 ? OK : fail('recovery_code_invalid');
}

/* -------------------------------------------------------------------------- */
/*  Admin branch                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Admin reauth: password + optional TOTP or recovery code. Recovery
 * codes are stored in `admin_user_recovery_codes` (mirror of the
 * firm-side table) and redeemed with the same atomic burn-on-use
 * pattern. Wallet factor is not supported on admin because admins
 * never link wallets.
 */
async function reauthAdmin(input: ReauthInput): Promise<ReauthResult> {
  const row = await input.db
    .select({
      id: schema.adminUsers.id,
      passwordHash: schema.adminUsers.passwordHash,
      totpSecretCiphertext: schema.adminUsers.totpSecretCiphertext,
      totpSecretNonce: schema.adminUsers.totpSecretNonce,
      totpKeyVersion: schema.adminUsers.totpKeyVersion,
      totpEnrolledAt: schema.adminUsers.totpEnrolledAt,
    })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, input.subject.id))
    .limit(1);

  const record = row[0];
  const verifiedHash = record?.passwordHash ?? null;
  const passwordStep = await checkPasswordStep(verifiedHash, input.password);
  if (passwordStep.status === 'failed') return passwordStep;

  switch (input.factor.type) {
    case 'none':
      return okWithHash(verifiedHash);
    case 'totp': {
      if (
        record === undefined ||
        record.totpEnrolledAt === null ||
        record.totpSecretCiphertext === null ||
        record.totpSecretNonce === null ||
        record.totpKeyVersion === null
      ) {
        return fail('totp_not_enrolled');
      }
      const secret = decryptTotpSecret(
        record.totpSecretCiphertext,
        record.totpSecretNonce,
        record.totpKeyVersion,
        input.authConfig.totpEncryptionKey,
      );
      // BUG #54: see `reauthFirm` — replay protection for the same
      // reason on the admin side.
      const ok = await verifyAndConsumeTotpCode(
        input.db,
        input.subject.id,
        'admin',
        secret,
        input.factor.code,
        input.authConfig,
      );
      return ok ? okWithHash(verifiedHash) : fail('totp_invalid');
    }
    case 'recovery_code': {
      const result = await verifyAdminRecoveryCode(input.db, input.subject.id, input.factor.code, input.now);
      return result.status === 'ok' ? okWithHash(verifiedHash) : result;
    }
    case 'wallet':
      return fail('factor_not_supported');
  }
}

/**
 * Atomically burn an admin recovery code. Mirrors the firm-side
 * `verifyFirmRecoveryCode` against `admin_user_recovery_codes` — same
 * `UPDATE ... RETURNING` race-free redemption.
 */
async function verifyAdminRecoveryCode(
  db: CrivacyDatabase,
  adminUserId: string,
  rawCode: string,
  now: Date,
): Promise<ReauthResult> {
  const codeHash = hashRecoveryCode(rawCode);
  const claimed = await db.execute<{ id: string }>(
    sql`UPDATE admin_user_recovery_codes
          SET used_at = ${now.toISOString()}
        WHERE admin_user_id = ${adminUserId}
          AND code_hash = ${codeHash}
          AND used_at IS NULL
        RETURNING id`,
  );
  return claimed.rows.length > 0 ? OK : fail('recovery_code_invalid');
}

/* -------------------------------------------------------------------------- */
/*  Shared steps                                                               */
/* -------------------------------------------------------------------------- */

const OK: ReauthResult = { status: 'ok', verifiedPasswordHash: null };

/**
 * Build a successful reauth result that carries forward the argon2 hash
 * the password step verified against. Callers that mutate `password_hash`
 * downstream should use this hash as a `WHERE password_hash = ...` race
 * guard so two concurrent state-change POSTs sharing the same correct
 * `currentPassword` cannot both flip the hash (BUG #53 cluster).
 */
function okWithHash(hash: string | null): ReauthResult {
  return { status: 'ok', verifiedPasswordHash: hash };
}

function fail(reason: ReauthReason): ReauthResult {
  return { status: 'failed', reason };
}

/**
 * Validate the password step against the argon2 hash currently on the
 * subject row. A `null` hash — either the row does not exist or the
 * subject never set a password (wallet-only customer) — collapses into
 * a distinct `password_not_set` outcome so the caller can route to the
 * appropriate UX without us leaking the row's existence via timing.
 *
 * A fixed dummy verification is NOT done here: the callsites for this
 * primitive are always session-authenticated, so the subject ID came
 * from the caller's own JWT. An attacker who reaches this code path
 * already controls the session — timing leaks on a self-owned row do
 * not provide meaningful enumeration signal.
 */
async function checkPasswordStep(
  storedHash: string | null,
  submittedPassword: string,
): Promise<ReauthResult> {
  if (storedHash === null) return fail('password_not_set');
  const ok = await verifyPassword(submittedPassword, storedHash);
  return ok ? OK : fail('wrong_password');
}

/**
 * Verify a wallet-signature factor: JWT → signature → linked-account
 * match. Burns the nonce BEFORE the linked-account lookup so a valid
 * but replayed signature cannot even probe for link existence.
 */
/* -------------------------------------------------------------------------- */
/*  Failure → HTTP response mapping                                             */
/* -------------------------------------------------------------------------- */

/**
 * Translate a {@link ReauthReason} into the `{code, message, status}`
 * triple that `ctx.errorJson()` consumes. Centralised so every settings
 * endpoint that reauths surfaces identical copy + status for a given
 * failure mode — a user who sees `wrong_password` on the firm side
 * must see the same shape on the customer side, and a UI that switches
 * a "Lost access? Use recovery code" link on `totp_invalid` must work
 * regardless of audience.
 */
export function reauthFailureResponse(reason: ReauthReason): {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly status: number;
} {
  switch (reason) {
    case 'password_not_set':
      // The caller has no password on file. A wallet-only customer
      // reaching this code path is attempting a flow that requires
      // first setting a password via `/profile/set-password` — surface
      // as a 409 so the UI can route to that flow rather than show a
      // generic 401.
      return {
        code: 'conflict',
        message: 'No password is set for this account. Set a password before continuing.',
        status: 409,
      };
    case 'wrong_password':
      return {
        code: 'unauthenticated',
        message: 'Current password is incorrect.',
        status: 401,
      };
    case 'totp_not_enrolled':
      return {
        code: 'totp_required',
        message: 'TOTP is not enrolled for this account.',
        status: 401,
      };
    case 'totp_invalid':
      return {
        code: 'totp_invalid',
        message: 'Invalid TOTP code.',
        status: 401,
      };
    case 'recovery_code_invalid':
      return {
        code: 'recovery_code_invalid',
        message: 'Invalid recovery code.',
        status: 401,
      };
    case 'wallet_challenge_invalid':
      return {
        code: 'validation_failed',
        message: 'Wallet challenge is expired, malformed, or already used.',
        status: 401,
      };
    case 'wallet_signature_invalid':
      return {
        code: 'unauthenticated',
        message: 'Wallet signature verification failed.',
        status: 401,
      };
    case 'factor_not_supported':
      return {
        code: 'validation_failed',
        message: 'The requested second factor cannot be used for this account.',
        status: 400,
      };
  }
}

/**
 * Wallet-only reauth — password step skipped.
 *
 * The add-email flow reaches the backend on wallet-only customers
 * (no password on file, no email on file). The full reauth gate
 * would short-circuit with `password_not_set` before the wallet
 * factor even runs. This helper exposes the wallet-factor pipeline
 * directly so those endpoints can attest identity via signature
 * alone — the caller is expected to have verified via another
 * means (existence of the session on a customer with no password
 * is itself proof the account was bootstrapped by a wallet login).
 *
 * The result shape matches {@link reauthGate} so the caller branches
 * on `status` identically; `reauthFailureResponse` maps the reasons
 * to the same HTTP shapes.
 */
export async function walletReauthGate(input: {
  readonly db: CrivacyDatabase;
  readonly customerId: string;
  readonly proof: Extract<ReauthFactor, { type: 'wallet' }>;
  readonly now: Date;
  readonly authConfig: AuthConfig;
}): Promise<ReauthResult> {
  return verifyWalletFactor(
    input.db,
    input.customerId,
    input.proof,
    input.now,
    input.authConfig,
  );
}

async function verifyWalletFactor(
  db: CrivacyDatabase,
  customerId: string,
  proof: Extract<ReauthFactor, { type: 'wallet' }>,
  now: Date,
  authConfig: AuthConfig,
): Promise<ReauthResult> {
  let nonce: string;
  try {
    nonce = await verifyWalletChallenge(proof.challenge, authConfig.jwtSecret);
  } catch {
    return fail('wallet_challenge_invalid');
  }

  const address = await verifyEvmWalletSignature({
    message: proof.message,
    signature: proof.signature as `0x${string}`,
    expectedNonce: nonce,
  });
  if (address === null) {
    return fail('wallet_signature_invalid');
  }

  // Burn nonce BEFORE linked-account lookup so the "does this wallet
  // belong to this customer?" probe cannot run on a replayed pair.
  const fresh = await claimWalletNonce(db, nonce, now);
  if (!fresh) return fail('wallet_challenge_invalid');

  const linked = await findLinkedAccount(db, 'evm_wallet', address);
  if (linked === null || linked.customerId !== customerId) {
    // Conflate "wrong wallet" with "bad signature" so an attacker
    // who happens to control a linked wallet on a different account
    // cannot distinguish the two outcomes by timing the response.
    return fail('wallet_signature_invalid');
  }

  return OK;
}
