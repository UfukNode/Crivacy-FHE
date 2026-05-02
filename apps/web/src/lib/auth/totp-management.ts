/**
 * Audience-agnostic TOTP management primitives.
 *
 * The firm dashboard and the admin console both need the same three
 * self-service flows — rotate the authenticator secret, disable TOTP
 * entirely, regenerate the recovery-code batch — plus a cheap read-
 * only "how many unused codes are left". Before this module those
 * flows lived as firm-only helpers in `lib/firm-auth/totp-management.ts`
 * and admin didn't have a path at all, which meant adding admin TOTP
 * management (Phase 4) was going to be a copy-paste with all the
 * drift risks that implies.
 *
 * The primitives here take a {@link TotpUserTableConfig} declaring
 * which subject table (`firm_users` / `admin_users`) and recovery-code
 * table to operate on. Config members are closed-union string literals
 * so the dynamic identifier interpolation (`sql.raw()`) has no path
 * for attacker-controlled input — TypeScript narrows the table names
 * to the approved set at every call site.
 *
 * Invariants enforced in every operation:
 *
 *   - **Atomic rotation** — each replace / disable / regenerate is a
 *     single `db.transaction()` that UPDATEs the user row and
 *     DELETEs/INSERTs recovery codes together. A crash between the
 *     two legs rolls back the whole thing; no half-rotated accounts.
 *
 *   - **No state peek before write** — the caller is expected to have
 *     already run reauth (password + factor) via {@link reauthGate};
 *     these primitives do not re-verify the factor, they just execute
 *     the DB-side state change.
 *
 *   - **Return raw codes exactly once** — `replaceTotp` and
 *     `regenerateRecoveryCodes` return a `recoveryCodes` array of
 *     plaintext strings that the caller is expected to surface to the
 *     user immediately; only SHA-256 hashes land in the DB, so the
 *     server cannot recover the raw codes after the response is sent.
 *
 * @module
 */

import { sql } from 'drizzle-orm';

import type { AuthConfig } from '@/lib/auth/config';
import { loadKeyFromBase64, seal } from '@/lib/auth/crypto-box';
import { AuthError } from '@/lib/auth/errors';
import { generateRecoveryCodeBatch } from '@/lib/auth/recovery-code';
import { verifyTotpCode } from '@/lib/auth/totp';
import type { CrivacyDatabase } from '@/lib/db/client';

/* -------------------------------------------------------------------------- */
/*  Table configuration                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Identifies the user table + companion recovery-codes table for a
 * given audience. Closed union — only firm and admin audiences have
 * TOTP today. Customer has no TOTP (wallet-only second factor), so
 * there is no customer variant.
 */
export interface TotpUserTableConfig {
  /** e.g. `firm_users`, `admin_users`. */
  readonly userTableName: 'firm_users' | 'admin_users';
  /** The PK column on the user table; always `id` for our schema. */
  readonly userIdColumn: 'id';
  /** The recovery-codes child table — must mirror `firm_user_recovery_codes` shape. */
  readonly recoveryCodesTableName:
    | 'firm_user_recovery_codes'
    | 'admin_user_recovery_codes';
  /** FK column on the recovery-codes table pointing back to the user. */
  readonly recoveryCodesSubjectColumn: 'firm_user_id' | 'admin_user_id';
}

/**
 * Config for the firm dashboard flows. Wired into every firm-side TOTP
 * management endpoint that previously imported from
 * `lib/firm-auth/totp-management.ts`.
 */
export const FIRM_TOTP_TABLE: TotpUserTableConfig = {
  userTableName: 'firm_users',
  userIdColumn: 'id',
  recoveryCodesTableName: 'firm_user_recovery_codes',
  recoveryCodesSubjectColumn: 'firm_user_id',
};

/**
 * Config for the admin console flows. The `admin_user_recovery_codes`
 * table is introduced alongside the admin settings greenfield work
 * (see Phase 4 tasks). Until the table migration lands, attempting to
 * use this config raises at runtime with a clear error.
 */
export const ADMIN_TOTP_TABLE: TotpUserTableConfig = {
  userTableName: 'admin_users',
  userIdColumn: 'id',
  recoveryCodesTableName: 'admin_user_recovery_codes',
  recoveryCodesSubjectColumn: 'admin_user_id',
};

/* -------------------------------------------------------------------------- */
/*  Replace TOTP                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Transaction-scoped post-mutation hook. Receives the same `tx` the
 * helper is running the state change on, so the caller can emit a
 * security event (or any other atomic write) inside the same
 * transaction — audit + email fan-out stay in lockstep with the
 * rotation.
 */
export type TotpMutationHook = (tx: Pick<CrivacyDatabase, 'execute'>) => Promise<void>;

export interface ReplaceTotpInput {
  readonly db: CrivacyDatabase;
  readonly authConfig: AuthConfig;
  readonly table: TotpUserTableConfig;
  /** UUID of the firm / admin user whose TOTP is being rotated. */
  readonly userId: string;
  /** Base32 secret produced by the new authenticator setup flow. */
  readonly newSecret: string;
  /** Code from the newly-configured authenticator app. */
  readonly newTotpCode: string;
  readonly now: Date;
  /** Optional callback invoked INSIDE the rotation transaction. */
  readonly onMutate?: TotpMutationHook;
}

export interface ReplaceTotpResult {
  /** Raw recovery codes — caller must surface to the user exactly once. */
  readonly recoveryCodes: ReadonlyArray<string>;
}

/**
 * Rotate the TOTP secret + regenerate recovery codes in one atomic
 * transaction. Verifies `newTotpCode` against `newSecret` BEFORE any
 * DB write, so a mistyped code never leaves the user half-rotated.
 */
export async function replaceTotp(input: ReplaceTotpInput): Promise<ReplaceTotpResult> {
  // 1. Sanity-check the new code against the new secret.
  if (!verifyTotpCode(input.newSecret, input.newTotpCode, input.authConfig)) {
    throw new AuthError('invalid_totp_code', 'The code does not match the new authenticator setup.');
  }

  // 2. Encrypt the new secret. Format matches the invite-accept +
  //    TOTP-enroll handlers so every decrypt path uses the same
  //    key-version lookup.
  const encKey = loadKeyFromBase64(input.authConfig.totpEncryptionKey);
  const sealed = seal(input.newSecret, encKey, input.authConfig.totpEncryptionKeyVersion);
  const ciphertext = Buffer.concat([sealed.ciphertext, sealed.tag]).toString('base64');
  const nonceB64 = Buffer.from(sealed.nonce).toString('base64');

  // 3. Generate the new backup codes. Raw values stay in memory for
  //    the response; only hashes land in the DB.
  const batch = generateRecoveryCodeBatch();

  // 4. Atomic rotation — secret + recovery codes move together.
  const userTable = sql.raw(`"${input.table.userTableName}"`);
  const userIdCol = sql.raw(`"${input.table.userIdColumn}"`);
  const recoveryTable = sql.raw(`"${input.table.recoveryCodesTableName}"`);
  const recoverySubjectCol = sql.raw(`"${input.table.recoveryCodesSubjectColumn}"`);

  await input.db.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE ${userTable}
            SET totp_secret_ciphertext = ${ciphertext},
                totp_secret_nonce = ${nonceB64},
                totp_key_version = ${input.authConfig.totpEncryptionKeyVersion},
                totp_enrolled_at = ${input.now.toISOString()},
                updated_at = ${input.now.toISOString()}
          WHERE ${userIdCol} = ${input.userId}`,
    );
    // DELETE rather than used_at-stamp — regeneration semantically
    // resets the batch, and leaving old hashes around would still
    // match against a leaked-hash brute-force if the attacker had a
    // pre-image oracle.
    await tx.execute(
      sql`DELETE FROM ${recoveryTable} WHERE ${recoverySubjectCol} = ${input.userId}`,
    );
    for (const code of batch) {
      await tx.execute(
        sql`INSERT INTO ${recoveryTable} (${recoverySubjectCol}, code_hash, created_at)
              VALUES (${input.userId}, ${code.hash}, ${input.now.toISOString()})`,
      );
    }
    if (input.onMutate !== undefined) {
      await input.onMutate(tx);
    }
  });

  return { recoveryCodes: batch.map((code) => code.raw) };
}

/* -------------------------------------------------------------------------- */
/*  Disable TOTP                                                               */
/* -------------------------------------------------------------------------- */

export interface DisableTotpInput {
  readonly db: CrivacyDatabase;
  readonly table: TotpUserTableConfig;
  readonly userId: string;
  readonly now: Date;
  /** See {@link TotpMutationHook}. */
  readonly onMutate?: TotpMutationHook;
}

/**
 * Wipe the TOTP state + recovery codes. Assumes the caller already
 * verified the required factors via reauthGate — this helper is the
 * pure DB-side wipe.
 */
export async function disableTotp(input: DisableTotpInput): Promise<void> {
  const userTable = sql.raw(`"${input.table.userTableName}"`);
  const userIdCol = sql.raw(`"${input.table.userIdColumn}"`);
  const recoveryTable = sql.raw(`"${input.table.recoveryCodesTableName}"`);
  const recoverySubjectCol = sql.raw(`"${input.table.recoveryCodesSubjectColumn}"`);

  await input.db.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE ${userTable}
            SET totp_secret_ciphertext = NULL,
                totp_secret_nonce = NULL,
                totp_key_version = NULL,
                totp_enrolled_at = NULL,
                updated_at = ${input.now.toISOString()}
          WHERE ${userIdCol} = ${input.userId}`,
    );
    await tx.execute(
      sql`DELETE FROM ${recoveryTable} WHERE ${recoverySubjectCol} = ${input.userId}`,
    );
    if (input.onMutate !== undefined) {
      await input.onMutate(tx);
    }
  });
}

/* -------------------------------------------------------------------------- */
/*  Regenerate recovery codes                                                  */
/* -------------------------------------------------------------------------- */

export interface RegenerateRecoveryCodesInput {
  readonly db: CrivacyDatabase;
  readonly table: TotpUserTableConfig;
  readonly userId: string;
  readonly now: Date;
  /** See {@link TotpMutationHook}. */
  readonly onMutate?: TotpMutationHook;
}

export interface RegenerateRecoveryCodesResult {
  readonly recoveryCodes: ReadonlyArray<string>;
}

/**
 * Wipe the current recovery-code batch + issue a fresh one. TOTP
 * secret stays untouched.
 */
export async function regenerateRecoveryCodes(
  input: RegenerateRecoveryCodesInput,
): Promise<RegenerateRecoveryCodesResult> {
  const recoveryTable = sql.raw(`"${input.table.recoveryCodesTableName}"`);
  const recoverySubjectCol = sql.raw(`"${input.table.recoveryCodesSubjectColumn}"`);

  const batch = generateRecoveryCodeBatch();
  await input.db.transaction(async (tx) => {
    await tx.execute(
      sql`DELETE FROM ${recoveryTable} WHERE ${recoverySubjectCol} = ${input.userId}`,
    );
    for (const code of batch) {
      await tx.execute(
        sql`INSERT INTO ${recoveryTable} (${recoverySubjectCol}, code_hash, created_at)
              VALUES (${input.userId}, ${code.hash}, ${input.now.toISOString()})`,
      );
    }
    if (input.onMutate !== undefined) {
      await input.onMutate(tx);
    }
  });
  return { recoveryCodes: batch.map((code) => code.raw) };
}

/* -------------------------------------------------------------------------- */
/*  Count remaining                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Read-only count of unused recovery codes for `userId`. Surfaced in
 * the settings UI so the user can see when it's time to regenerate.
 */
export async function countRemainingRecoveryCodes(
  db: CrivacyDatabase,
  table: TotpUserTableConfig,
  userId: string,
): Promise<number> {
  const recoveryTable = sql.raw(`"${table.recoveryCodesTableName}"`);
  const recoverySubjectCol = sql.raw(`"${table.recoveryCodesSubjectColumn}"`);

  const result = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count
          FROM ${recoveryTable}
         WHERE ${recoverySubjectCol} = ${userId}
           AND used_at IS NULL`,
  );
  const row = result.rows[0] as { count: string } | undefined;
  return Number.parseInt(row?.count ?? '0', 10);
}
