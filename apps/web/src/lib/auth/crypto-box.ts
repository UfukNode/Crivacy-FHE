/**
 * AES-256-GCM envelope for secret-at-rest.
 *
 * Used by the TOTP helpers to encrypt a user's Base32 secret before
 * storing it in `firm_users.totp_secret_ciphertext`. The same envelope
 * format is suitable for any short confidential blob the server must
 * read back (API key rotation PKs, backup codes, etc.). For large
 * objects we would use streaming GCM — this helper is for inputs that
 * fit in a single Buffer.
 *
 * Layout produced by `seal()`:
 *
 *     SealedBox.ciphertext  = encrypted payload
 *     SealedBox.nonce       = 12-byte IV (unique per call)
 *     SealedBox.tag         = 16-byte GCM authentication tag
 *     SealedBox.keyVersion  = integer matching the DB column so we can
 *                             rotate data keys without a migration
 *
 * `serialize()` turns a `SealedBox` into the three DB columns
 * (`base64(ciphertext ++ tag)`, `base64(nonce)`, integer) used across
 * `firm_users` and `admin_users`. `deserialize()` is the inverse.
 *
 * Key material is supplied by the caller as a 32-byte `Buffer`. The
 * `loadKey()` helper decodes the base64 string from `AUTH_TOTP_ENCRYPTION_KEY`
 * and asserts its length exactly matches AES-256.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import { AuthError } from './errors';

const AES_KEY_BYTES = 32; // AES-256
const GCM_NONCE_BYTES = 12;

/** GCM authentication tag length in bytes. Exported for consumers that need to slice raw ciphertext. */
export const GCM_TAG_BYTES = 16;

/**
 * In-memory representation of a sealed payload. Callers receive this
 * shape from `seal()` and hand it to `open()` (or to `serialize()` for
 * DB storage).
 */
export interface SealedBox {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly keyVersion: number;
}

/**
 * DB column shape: what the three `_ciphertext`, `_nonce`, `_key_version`
 * columns on `firm_users` / `admin_users` actually store.
 *
 * `ciphertextBase64` contains `ciphertext ++ tag` concatenated, so a
 * caller only needs to persist two strings plus one integer.
 */
export interface SerializedSealedBox {
  readonly ciphertextBase64: string;
  readonly nonceBase64: string;
  readonly keyVersion: number;
}

/* ---------- Key loading ---------- */

/**
 * Decode a base64-encoded 32-byte AES key.
 *
 * Intentionally validates the exact decoded length; a 16- or 24-byte
 * buffer would silently pick AES-128/AES-192, which is a cryptographic
 * downgrade we refuse to allow.
 */
export function loadKeyFromBase64(base64: string): Buffer {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch (cause) {
    throw new AuthError('crypto_box_invalid_key', 'key is not valid base64', { cause });
  }
  // Node's `Buffer.from(..., 'base64')` never throws; invalid chars are
  // silently dropped. The only honest check is length.
  if (buffer.length !== AES_KEY_BYTES) {
    throw new AuthError(
      'crypto_box_invalid_key',
      `key must decode to ${AES_KEY_BYTES} bytes (got ${buffer.length})`,
    );
  }
  return buffer;
}

/* ---------- seal / open ---------- */

/**
 * Encrypt `plaintext` under `key` with a fresh 96-bit nonce. Returns the
 * opaque `SealedBox` that only `open()` with the matching key can read.
 *
 * The caller supplies the current `keyVersion` so that the DB row
 * records which key was active when the value was written; this keeps
 * key rotation non-destructive.
 */
export function seal(plaintext: Buffer | string, key: Buffer, keyVersion: number): SealedBox {
  assertKey(key);
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new AuthError('crypto_box_invalid', 'keyVersion must be a positive integer');
  }
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const payload = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, nonce, tag, keyVersion };
}

/**
 * Decrypt a sealed box. Throws `AuthError('crypto_box_invalid')` if the
 * GCM authentication tag fails — do not fall back to a plaintext compare
 * or log the ciphertext on failure.
 */
export function open(box: SealedBox, key: Buffer): Buffer {
  assertKey(key);
  if (box.nonce.length !== GCM_NONCE_BYTES) {
    throw new AuthError('crypto_box_invalid', 'nonce has wrong length');
  }
  if (box.tag.length !== GCM_TAG_BYTES) {
    throw new AuthError('crypto_box_invalid', 'auth tag has wrong length');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, box.nonce);
  decipher.setAuthTag(box.tag);
  try {
    return Buffer.concat([decipher.update(box.ciphertext), decipher.final()]);
  } catch (cause) {
    throw new AuthError('crypto_box_invalid', 'authentication tag check failed', { cause });
  }
}

/* ---------- serialize / deserialize ---------- */

/**
 * Flatten a `SealedBox` into the three DB columns. Uses `base64`
 * (standard, with padding) — base64url is not required because the
 * value lives in a TEXT column, not a URL.
 */
export function serialize(box: SealedBox): SerializedSealedBox {
  return {
    ciphertextBase64: Buffer.concat([box.ciphertext, box.tag]).toString('base64'),
    nonceBase64: box.nonce.toString('base64'),
    keyVersion: box.keyVersion,
  };
}

/**
 * Inverse of `serialize()`. Splits the trailing 16-byte tag back off.
 * Throws if the decoded buffer is shorter than the tag itself — that
 * means the row was truncated somewhere between write and read.
 */
export function deserialize(input: SerializedSealedBox): SealedBox {
  const merged = Buffer.from(input.ciphertextBase64, 'base64');
  if (merged.length < GCM_TAG_BYTES) {
    throw new AuthError(
      'crypto_box_invalid',
      'serialized ciphertext is shorter than the GCM auth tag',
    );
  }
  const ciphertext = merged.subarray(0, merged.length - GCM_TAG_BYTES);
  const tag = merged.subarray(merged.length - GCM_TAG_BYTES);
  const nonce = Buffer.from(input.nonceBase64, 'base64');
  if (nonce.length !== GCM_NONCE_BYTES) {
    throw new AuthError('crypto_box_invalid', 'nonce has wrong length after decode');
  }
  return { ciphertext, nonce, tag, keyVersion: input.keyVersion };
}

/* ---------- Key rotation helper ---------- */

/**
 * Look up a data key by version. Applications that rotate the
 * `AUTH_TOTP_ENCRYPTION_KEY` keep the retired base64 strings around so
 * old rows can still be opened; the lookup is therefore the caller's
 * responsibility. This helper only defends against version mismatches.
 */
export function selectKeyForVersion(
  box: Pick<SealedBox, 'keyVersion'>,
  keys: ReadonlyMap<number, Buffer>,
): Buffer {
  const key = keys.get(box.keyVersion);
  if (!key) {
    throw new AuthError(
      'crypto_box_unknown_key_version',
      `no data key registered for version ${box.keyVersion}`,
    );
  }
  return key;
}

/**
 * Constant-time equality helper re-exported so callers do not have to
 * reach into `node:crypto` just to compare two byte strings safely.
 */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/* ---------- Private ---------- */

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
    throw new AuthError('crypto_box_invalid_key', `key must be a ${AES_KEY_BYTES}-byte Buffer`);
  }
}
