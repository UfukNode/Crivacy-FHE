/**
 * Shared TOTP secret decryption.
 *
 * Both `admin-auth.ts` and `dashboard-auth.ts` need to decrypt a stored
 * TOTP secret during login. This helper eliminates the duplicated
 * buffer-slicing pattern by using the existing `deserialize()` + `open()`
 * from `crypto-box.ts`.
 *
 * @module
 */

import { deserialize, loadKeyFromBase64, open } from './crypto-box';

/**
 * Decrypt a TOTP secret stored in the DB as three columns:
 * `totp_secret_ciphertext` (base64), `totp_secret_nonce` (base64),
 * `totp_key_version` (int).
 *
 * Returns the plain-text Base32 TOTP secret.
 */
export function decryptTotpSecret(
  ciphertextBase64: string,
  nonceBase64: string,
  keyVersion: number,
  totpEncryptionKeyBase64: string,
): string {
  const encKey = loadKeyFromBase64(totpEncryptionKeyBase64);
  const box = deserialize({ ciphertextBase64, nonceBase64, keyVersion });
  const secretBuf = open(box, encKey);
  return secretBuf.toString('utf8');
}
