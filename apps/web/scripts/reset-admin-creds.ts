/**
 * Reset password + TOTP + recovery codes for a single admin user.
 * One-shot recovery script for `admin@crivacy.io` after credential
 * loss. Mirrors `seed-page9-admins.ts` envelope (argon2id OWASP 2024
 * defaults + AES-256-GCM TOTP seal + 8-code recovery batch) but
 * UPDATEs an existing row instead of INSERTing.
 *
 * Atomic: single transaction wraps the UPDATE + DELETE + INSERTs so
 * a partial failure cannot leave the admin row with a new password
 * but stale recovery codes (or vice versa).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/reset-admin-creds.ts <email> <newPassword>
 *
 * Outputs the new TOTP Base32 secret + 8 recovery codes ONCE — they
 * are not retrievable afterwards. Pin them in the audit fixture.
 */

import { hash } from '@node-rs/argon2';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { loadKeyFromBase64, seal } from '../src/lib/auth/crypto-box';
import { generateRecoveryCodeBatch } from '../src/lib/auth/recovery-code';
import { generateTotpSecret } from '../src/lib/auth/totp';

const { Pool } = pg;

const ARGON2_OPTIONS = {
  algorithm: 2 as const,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

async function main(): Promise<void> {
  const [, , emailArg, passwordArg] = process.argv;
  if (emailArg === undefined || passwordArg === undefined) {
    console.error('Usage: tsx scripts/reset-admin-creds.ts <email> <newPassword>');
    process.exit(1);
  }

  const databaseUrl = process.env['DATABASE_URL'];
  const totpKeyB64 = process.env['AUTH_TOTP_ENCRYPTION_KEY'];
  const keyVersion = Number(process.env['AUTH_TOTP_ENCRYPTION_KEY_VERSION'] ?? '1');

  if (databaseUrl === undefined) {
    console.error('ERROR: DATABASE_URL not set');
    process.exit(1);
  }
  if (totpKeyB64 === undefined) {
    console.error('ERROR: AUTH_TOTP_ENCRYPTION_KEY not set');
    process.exit(1);
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    console.error(`ERROR: AUTH_TOTP_ENCRYPTION_KEY_VERSION must be a positive integer (got ${keyVersion})`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const db = drizzle(pool);

  try {
    const existing = await db.execute(
      sql`SELECT id FROM admin_users WHERE lower(email) = ${emailArg.toLowerCase()} LIMIT 1`,
    );
    const adminId = existing.rows[0]?.['id'] as string | undefined;
    if (adminId === undefined) {
      console.error(`ERROR: no admin_users row for email ${emailArg}`);
      process.exit(1);
    }

    const passwordHash = await hash(passwordArg, ARGON2_OPTIONS);
    const totpSecretB32 = generateTotpSecret();
    const encKey = loadKeyFromBase64(totpKeyB64);
    const sealed = seal(totpSecretB32, encKey, keyVersion);
    const ciphertextB64 = Buffer.concat([sealed.ciphertext, sealed.tag]).toString('base64');
    const nonceB64 = Buffer.from(sealed.nonce).toString('base64');
    const recoveryBatch = generateRecoveryCodeBatch();

    await db.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE admin_users SET
              password_hash = ${passwordHash},
              totp_secret_ciphertext = ${ciphertextB64},
              totp_secret_nonce = ${nonceB64},
              totp_key_version = ${keyVersion},
              totp_enrolled_at = NOW(),
              password_changed_at = NOW(),
              failed_login_count = 0,
              failed_login_first_at = NULL,
              locked_at = NULL,
              locked_until = NULL,
              updated_at = NOW()
            WHERE id = ${adminId}`,
      );

      await tx.execute(
        sql`DELETE FROM admin_user_recovery_codes WHERE admin_user_id = ${adminId}`,
      );

      for (const { hash: codeHash } of recoveryBatch) {
        await tx.execute(
          sql`INSERT INTO admin_user_recovery_codes (admin_user_id, code_hash)
              VALUES (${adminId}, ${codeHash})`,
        );
      }
    });

    console.log('');
    console.log('==================================================');
    console.log(`OK: reset ${emailArg} (id: ${adminId})`);
    console.log('==================================================');
    console.log(`  password:      ${passwordArg}`);
    console.log(`  totp_b32:      ${totpSecretB32}`);
    console.log(`  totp_keyver:   ${keyVersion}`);
    console.log(`  recovery codes (8) — one-time, paste into authenticator + save:`);
    for (const { raw } of recoveryBatch) {
      console.log(`    - ${raw}`);
    }
    console.log('==================================================');
    console.log('Otpauth URI (paste into authenticator if QR not handy):');
    const issuer = encodeURIComponent('Crivacy');
    const label = encodeURIComponent(`Crivacy:${emailArg}`);
    console.log(`  otpauth://totp/${label}?secret=${totpSecretB32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`);
    console.log('==================================================');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('reset failed:', err);
  process.exit(1);
});
