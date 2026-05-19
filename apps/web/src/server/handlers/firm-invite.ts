/**
 * Firm-user invitation acceptance flow.
 *
 * Two handlers, chained from the email-link landing page:
 *
 *   1. {@link handleValidateFirmInvite} — token check. Returns the
 *      recipient's email + firm name so the UI can render a welcome
 *      form, plus a freshly-generated TOTP secret + `otpauth://` URL
 *      so the user can enrol their authenticator app on the same
 *      page. The secret is NOT persisted until the user proves
 *      possession of it in step 2.
 *
 *   2. {@link handleAcceptFirmInvite} — finaliser. Takes the token,
 *      the password chosen by the user, the TOTP secret returned in
 *      step 1, and the 6-digit code. Hashes the password (argon2id),
 *      encrypts the secret (AES-GCM), stamps `accepted_at`, burns
 *      the invite, revokes any stale sessions for this user, and
 *      issues a fresh access+refresh pair so the caller lands
 *      authenticated on `/dashboard` without a separate login hop.
 *
 * Any caller-level error (unknown/expired/used token, weak password
 * rejected upstream by Zod, mismatched TOTP code) short-circuits with
 * a typed `AuthError` which the route translates to the matching
 * HTTP status.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import type { CrivacyDatabase } from '@/lib/db/client';
import { buildSession } from '@/lib/auth/sessions';
import {
  buildOtpauthUrl,
  generateTotpSecret,
  verifyTotpCode,
} from '@/lib/auth/totp';
import { seal, loadKeyFromBase64 } from '@/lib/auth/crypto-box';
import { hashPassword } from '@/lib/auth/password';
import { assertPasswordNotPwned } from '@/lib/auth/pwned-passwords';
import { generateRecoveryCodeBatch } from '@/lib/auth/recovery-code';
import type { AuthConfig } from '@/lib/auth/config';
import { AuthError } from '@/lib/auth/errors';
import {
  acceptFirmUserInvite,
  lookupFirmUserInvite,
} from '../repositories/admin';
import type { ValidatedFirmInvite } from '../repositories/admin';

/* ---------- Validate ---------- */

export interface ValidateFirmInviteResult {
  readonly email: string;
  readonly firmName: string;
  readonly totpSecret: string;
  readonly otpauthUrl: string;
}

/**
 * Inspect the token and, on success, return the recipient context +
 * a fresh TOTP secret the user will enrol during acceptance. Failure
 * cases map to a typed {@link AuthError} whose code the route can
 * translate to the right HTTP status (404 / 410).
 */
export async function handleValidateFirmInvite(
  deps: {
    readonly db: CrivacyDatabase;
    readonly authConfig: AuthConfig;
    readonly now: Date;
  },
  token: string,
): Promise<ValidateFirmInviteResult> {
  const result = await lookupFirmUserInvite(deps.db, token, deps.now);

  if (result.status === 'not_found') {
    throw new AuthError('not_found', 'Invitation not found.');
  }
  if (result.status === 'used') {
    throw new AuthError('invite_used', 'This invitation has already been used.');
  }
  if (result.status === 'expired') {
    throw new AuthError('invite_expired', 'This invitation has expired.');
  }
  if (result.status === 'firm_deactivated') {
    // Admin deactivated the firm after the welcome email went out.
    // Fail here instead of walking the recipient through the TOTP
    // setup just to have the dashboard reject them at login.
    throw new AuthError(
      'invite_revoked',
      'This firm has been deactivated. Ask your administrator to reactivate it or send a new invitation.',
    );
  }

  const { invite } = result;
  const totpSecret = generateTotpSecret();
  const otpauthUrl = buildOtpauthUrl(totpSecret, invite.email, deps.authConfig);

  return {
    email: invite.email,
    firmName: invite.firmName,
    totpSecret,
    otpauthUrl,
  };
}

/* ---------- Accept ---------- */

export interface AcceptFirmInviteInput {
  readonly token: string;
  readonly password: string;
  readonly totpSecret: string;
  readonly totpCode: string;
}

export interface AcceptFirmInviteResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly role: string;
    readonly firmId: string;
  };
  /**
   * Raw recovery codes issued alongside the TOTP enrolment. Surfaced
   * exactly once in this response — the route MUST hand them off to
   * the UI so the user can print/save them before the page unloads.
   * Only the SHA-256 hashes live in the DB.
   */
  readonly recoveryCodes: readonly string[];
}

export interface AcceptFirmInviteDeps {
  readonly db: CrivacyDatabase;
  readonly authConfig: AuthConfig;
  readonly now: Date;
  readonly insertSession: (
    db: CrivacyDatabase,
    record: Record<string, unknown>,
  ) => Promise<{ readonly id: string }>;
  readonly revokeAllUserSessions: (
    db: CrivacyDatabase,
    userId: string,
    reason: string,
    now: Date,
  ) => Promise<void>;
}

export async function handleAcceptFirmInvite(
  deps: AcceptFirmInviteDeps,
  input: AcceptFirmInviteInput,
): Promise<AcceptFirmInviteResult> {
  // 1. Re-validate the token. Re-doing the lookup means any
  // concurrent admin-rescind / self-expire between /validate and
  // /accept still rejects here.
  const result = await lookupFirmUserInvite(deps.db, input.token, deps.now);
  if (result.status === 'not_found') {
    throw new AuthError('not_found', 'Invitation not found.');
  }
  if (result.status === 'used') {
    throw new AuthError('invite_used', 'This invitation has already been used.');
  }
  if (result.status === 'expired') {
    throw new AuthError('invite_expired', 'This invitation has expired.');
  }
  if (result.status === 'firm_deactivated') {
    // Re-check on accept — the firm may have been deactivated
    // between /validate and /accept. Same message as the validate
    // path so the UI doesn't have to differentiate.
    throw new AuthError(
      'invite_revoked',
      'This firm has been deactivated. Ask your administrator to reactivate it or send a new invitation.',
    );
  }
  const invite: ValidatedFirmInvite = result.invite;

  // 2. Prove the user possesses the TOTP secret surfaced in step 1.
  // This is what keeps the secret safely out of the DB until now —
  // we never persist a secret the user hasn't demonstrated access
  // to. Any drift across the Window is handled inside verifyTotpCode.
  const totpValid = verifyTotpCode(input.totpSecret, input.totpCode, deps.authConfig);
  if (!totpValid) {
    throw new AuthError('invalid_totp_code', 'Invalid TOTP code.');
  }

  // 3. Reject passwords in the HIBP breach corpus before we spend
  // the argon2 cost — a newly-invited firm user should not start
  // life with a credential that is already in every stuffing bot's
  // wordlist.
  await assertPasswordNotPwned(input.password);

  // 4. Hash password + encrypt TOTP secret using the configured
  // data-key. Encryption matches the existing /totp/verify flow so
  // the login handler can decrypt with the same key-version lookup.
  const passwordHash = await hashPassword(input.password, deps.authConfig);
  const encKey = loadKeyFromBase64(deps.authConfig.totpEncryptionKey);
  const sealed = seal(input.totpSecret, encKey, deps.authConfig.totpEncryptionKeyVersion);
  const totpCiphertext = Buffer.concat([sealed.ciphertext, sealed.tag]).toString('base64');
  const totpNonce = Buffer.from(sealed.nonce).toString('base64');

  // 4. Generate the initial recovery-code batch. Raw codes stay in
  // memory to hand back to the UI; only the hashes go near the DB.
  const recoveryBatch = generateRecoveryCodeBatch();

  // 5. Burn the invite + stamp password/TOTP/accepted_at + insert
  // recovery-code hashes atomically. All four writes share a single
  // transaction inside the repository so a half-enrolled user is
  // impossible.
  const burned = await acceptFirmUserInvite(deps.db, {
    inviteId: invite.inviteId,
    firmUserId: invite.firmUserId,
    passwordHash,
    totpCiphertext,
    totpNonce,
    totpKeyVersion: deps.authConfig.totpEncryptionKeyVersion,
    recoveryCodeHashes: recoveryBatch.map((code) => code.hash),
    now: deps.now,
  });
  if (!burned) {
    throw new AuthError('invite_used', 'This invitation has already been used.');
  }

  // 5. Revoke any stale sessions (defensive — newly accepted users
  // shouldn't have any, but this covers re-invite / admin flows) and
  // issue a fresh pair so the browser can redirect to /dashboard
  // already signed in.
  await deps.revokeAllUserSessions(
    deps.db,
    invite.firmUserId,
    'superseded_by_accept_invite',
    deps.now,
  );

  const session = await buildSession(
    {
      kind: 'firm',
      userId: invite.firmUserId,
      firmId: invite.firmId,
      role: 'owner',
      ip: null,
      userAgent: null,
    },
    deps.authConfig,
    deps.now,
  );

  await deps.insertSession(deps.db, {
    id: randomUUID(),
    userId: session.record.userId,
    userKind: session.record.userKind as 'firm',
    jwtJti: session.record.jwtJti,
    refreshTokenHash: session.record.refreshTokenHash,
    refreshTokenVersion: session.record.refreshTokenVersion,
    expiresAt: session.record.expiresAt,
    refreshExpiresAt: session.record.refreshExpiresAt,
    ip: session.record.ip,
    userAgent: session.record.userAgent,
  });

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.accessExpiresAt,
    user: {
      id: invite.firmUserId,
      email: invite.email,
      role: 'owner',
      firmId: invite.firmId,
    },
    recoveryCodes: recoveryBatch.map((code) => code.raw),
  };
}
