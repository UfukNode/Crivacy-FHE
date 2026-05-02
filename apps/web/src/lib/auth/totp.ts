/**
 * RFC 6238 TOTP, hand-rolled against Node's `crypto` module.
 *
 * Dashboard sign-in requires a 6-digit code produced from the user's
 * shared secret. The secret is a 20-byte random value encoded as
 * RFC 4648 Base32 (32 ASCII chars, upper-case, no padding) — the
 * format compatible with every authenticator app (Google, Microsoft,
 * 1Password, Bitwarden, Aegis, FreeOTP, Ente Auth).
 *
 * Algorithm:
 *
 *   1. Counter T = floor((now - T0) / X)       (T0 = 0, X = step seconds)
 *   2. HMAC = HMAC-SHA1(secret, T as 8-byte big-endian integer)
 *   3. Dynamic truncation:                     (see RFC 4226 §5.3)
 *        offset = HMAC[19] & 0x0F
 *        bin    = (HMAC[offset]   & 0x7F) << 24
 *               | (HMAC[offset+1] & 0xFF) << 16
 *               | (HMAC[offset+2] & 0xFF) <<  8
 *               | (HMAC[offset+3] & 0xFF)
 *        code   = bin % 10^digits
 *   4. Code is zero-padded left to `digits` characters.
 *
 * Verification accepts a symmetric drift window of ±`driftSteps`
 * counters to tolerate clock skew. The default is ±1 (±30 s); values
 * above 3 are rejected by config validation so a misconfigured env
 * cannot widen the attack surface accidentally.
 *
 * The helper also emits the otpauth URL consumed by QR-code
 * enrollment: `otpauth://totp/<issuer>:<label>?secret=<b32>&issuer=<issuer>&digits=6&period=30&algorithm=SHA1`.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { AuthConfig } from './config';
import { AuthError } from './errors';

/* ---------- Constants ---------- */

const TOTP_SECRET_BYTES = 20; // 160-bit, RFC 6238 recommended minimum for SHA-1
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const COUNTER_BYTES = 8;

/* ---------- Types ---------- */

export type TotpConfig = Pick<
  AuthConfig,
  'totpIssuer' | 'totpStepSeconds' | 'totpDigits' | 'totpDriftSteps'
>;

export interface GenerateTotpOptions {
  /** Override the step counter for deterministic tests. */
  readonly counter?: number;
  /** Override the current time (seconds since epoch) for deterministic tests. */
  readonly nowSeconds?: number;
}

/* ---------- Secret generation + Base32 ---------- */

/**
 * Generate a 20-byte (160-bit) secret encoded as Base32. This is the
 * format expected by every mainstream authenticator app.
 */
export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(TOTP_SECRET_BYTES));
}

/**
 * RFC 4648 Base32 encoder (no padding). Hand-rolled so we do not
 * inherit a dependency for ~30 lines of code. Padding is omitted
 * because every authenticator app strips it anyway.
 */
export function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/**
 * RFC 4648 Base32 decoder. Tolerant of lower-case and of internal
 * whitespace (`"JBSW Y3DP"` is accepted) because users routinely
 * paste secrets with spaces from a QR-code export. Rejects any
 * non-alphabet character otherwise.
 */
export function decodeBase32(input: string): Buffer {
  if (typeof input !== 'string') {
    throw new AuthError('invalid_totp_secret', 'Base32 input must be a string');
  }
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
  if (cleaned.length === 0) {
    throw new AuthError('invalid_totp_secret', 'Base32 input is empty');
  }
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) {
      throw new AuthError('invalid_totp_secret', `non-Base32 character: ${char}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(output);
}

/* ---------- HOTP / TOTP core ---------- */

/**
 * Produce a code for an explicit 64-bit counter. Used by both
 * `generateTotpCode` (which computes the counter from the clock) and
 * `verifyTotpCode` (which iterates over drift-adjusted counters).
 */
export function generateHotpCode(secret: Buffer, counter: number, digits: 6 | 7 | 8): string {
  if (!Number.isInteger(counter) || counter < 0) {
    throw new AuthError('invalid_totp_code', 'counter must be a non-negative integer');
  }
  const counterBuf = Buffer.alloc(COUNTER_BYTES);
  // JavaScript's 53-bit safe integer range is enough for any TOTP
  // counter we will ever see (a step of 30 s over the lifetime of the
  // universe is ~5 × 10^16 < 2^56, and T0 starts at 0). We still split
  // into high/low halves to avoid relying on BigInt for byte-write.
  const high = Math.floor(counter / 0x1_0000_0000);
  const low = counter - high * 0x1_0000_0000;
  counterBuf.writeUInt32BE(high, 0);
  counterBuf.writeUInt32BE(low, 4);

  const hmac = createHmac('sha1', secret).update(counterBuf).digest();
  // RFC 4226 §5.3 dynamic truncation: the offset is the low nibble of the
  // final byte; the 31-bit binary code is the big-endian 32-bit word at
  // that offset, with the top bit cleared. `readUInt8` / `readUInt32BE`
  // are the idiomatic Node Buffer accessors and remove the need for
  // bang-asserted indexing.
  const offset = hmac.readUInt8(hmac.length - 1) & 0x0f;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  const code = bin % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

/**
 * Produce the TOTP for a given secret and time. `config.totpDigits`
 * and `config.totpStepSeconds` drive the output. `opts.counter` and
 * `opts.nowSeconds` are test hooks.
 */
export function generateTotpCode(
  base32Secret: string,
  config: TotpConfig,
  opts: GenerateTotpOptions = {},
): string {
  const secret = decodeBase32(base32Secret);
  const counter =
    opts.counter ??
    Math.floor((opts.nowSeconds ?? Math.floor(Date.now() / 1000)) / config.totpStepSeconds);
  return generateHotpCode(secret, counter, config.totpDigits);
}

/**
 * Verify a user-provided code against the expected counter (and its
 * neighbours inside the configured drift window). Returns `true` if
 * any counter matches, `false` otherwise. Comparison is constant-time
 * against each candidate to defeat trivial timing leaks.
 */
export function verifyTotpCode(
  base32Secret: string,
  userCode: string,
  config: TotpConfig,
  opts: GenerateTotpOptions = {},
): boolean {
  if (typeof userCode !== 'string' || !/^\d+$/.test(userCode)) {
    return false;
  }
  if (userCode.length !== config.totpDigits) {
    return false;
  }
  let secret: Buffer;
  try {
    secret = decodeBase32(base32Secret);
  } catch {
    return false;
  }
  const baseCounter =
    opts.counter ??
    Math.floor((opts.nowSeconds ?? Math.floor(Date.now() / 1000)) / config.totpStepSeconds);
  const userBuf = Buffer.from(userCode, 'utf8');
  let accepted = false;
  // Iterate across the full symmetric window even after a match so
  // the outer boolean decision stays independent of the match
  // position — a modest defence against timing inference.
  for (let delta = -config.totpDriftSteps; delta <= config.totpDriftSteps; delta += 1) {
    const candidateCounter = baseCounter + delta;
    if (candidateCounter < 0) continue;
    const candidate = generateHotpCode(secret, candidateCounter, config.totpDigits);
    const candBuf = Buffer.from(candidate, 'utf8');
    if (candBuf.length === userBuf.length && timingSafeEqual(candBuf, userBuf)) {
      accepted = true;
    }
  }
  return accepted;
}

/**
 * Same `userCode` against the drift window as {@link verifyTotpCode},
 * but additionally records the matched counter as consumed so the
 * code cannot be replayed within RFC 6238 §5.2's "MUST NOT accept the
 * second attempt" window. Atomic via INSERT ... ON CONFLICT DO
 * NOTHING — the loser of any concurrent submission of the same code
 * sees `rowCount === 0` and the function returns `false` even though
 * the HMAC matched.
 *
 * BUG #54 (P2): the stateless `verifyTotpCode` accepted the same
 * 6-digit code twice within the drift window (runtime-reproduced
 * 2026-04-26 against firm B login). An attacker observing a TOTP
 * during entry (shoulder-surf, screen recording, MITM intercept of
 * the login form post) could replay it before the legit user's
 * session was minted. This wrapper closes that window: matched-but-
 * already-consumed = rejected.
 *
 * The caller passes a {@link CrivacyDatabase} (or transaction handle)
 * + the subject's id and kind so the row write joins the surrounding
 * write context. Side-effect-free if `userCode` does not match any
 * counter in the drift window — no row is written.
 */
export async function verifyAndConsumeTotpCode(
  db: import('@/lib/db/client').CrivacyDatabase,
  userId: string,
  userKind: 'firm' | 'admin' | 'customer',
  base32Secret: string,
  userCode: string,
  config: TotpConfig,
  opts: GenerateTotpOptions = {},
): Promise<boolean> {
  if (typeof userCode !== 'string' || !/^\d+$/.test(userCode)) {
    return false;
  }
  if (userCode.length !== config.totpDigits) {
    return false;
  }
  let secret: Buffer;
  try {
    secret = decodeBase32(base32Secret);
  } catch {
    return false;
  }
  const baseCounter =
    opts.counter ??
    Math.floor((opts.nowSeconds ?? Math.floor(Date.now() / 1000)) / config.totpStepSeconds);
  const userBuf = Buffer.from(userCode, 'utf8');

  // Find the matching counter (if any) in the drift window. We still
  // iterate the full window even after a match for the same timing-
  // independence reason as `verifyTotpCode`; record the match offset
  // separately so the dedup write happens for exactly one counter.
  let matchedCounter: number | null = null;
  for (let delta = -config.totpDriftSteps; delta <= config.totpDriftSteps; delta += 1) {
    const candidateCounter = baseCounter + delta;
    if (candidateCounter < 0) continue;
    const candidate = generateHotpCode(secret, candidateCounter, config.totpDigits);
    const candBuf = Buffer.from(candidate, 'utf8');
    if (candBuf.length === userBuf.length && timingSafeEqual(candBuf, userBuf)) {
      // First match wins — multiple counters cannot collide on a
      // single 6-digit output within the drift window without an
      // astronomically improbable HMAC accident.
      if (matchedCounter === null) {
        matchedCounter = candidateCounter;
      }
    }
  }
  if (matchedCounter === null) {
    return false;
  }

  // Atomic single-use claim: INSERT ON CONFLICT DO NOTHING. If the
  // INSERT succeeds we own the consume; if it loses to a parallel
  // verify that already booked this counter for this user, we treat
  // it as a replay and reject.
  const { sql: drizzleSql } = await import('drizzle-orm');
  const claimed = await db.execute<{ counter: string }>(
    drizzleSql`INSERT INTO totp_used_codes (user_id, user_kind, counter)
       VALUES (${userId}, ${userKind}, ${matchedCounter})
       ON CONFLICT (user_id, user_kind, counter) DO NOTHING
       RETURNING counter`,
  );
  return claimed.rowCount === 1;
}

/* ---------- otpauth URL ---------- */

/**
 * Build the otpauth URL that authenticator apps render as a QR code.
 * Format is the de-facto standard documented in the Google
 * Authenticator Key URI specification.
 *
 * Both `issuer` (as a path prefix and a query parameter) are kept in
 * sync so older apps that only parse one or the other still show the
 * correct label.
 */
export function buildOtpauthUrl(
  base32Secret: string,
  accountLabel: string,
  config: TotpConfig,
): string {
  if (typeof accountLabel !== 'string' || accountLabel.length === 0) {
    throw new AuthError('invalid_totp_secret', 'accountLabel must be a non-empty string');
  }
  // Both the label prefix and the `issuer` query parameter carry the
  // issuer so that every spec revision of the Google Authenticator
  // Key URI Format (including apps that only honour one or the other)
  // renders the correct brand.
  const label = encodeURIComponent(`${config.totpIssuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: base32Secret,
    issuer: config.totpIssuer,
    algorithm: 'SHA1',
    digits: String(config.totpDigits),
    period: String(config.totpStepSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
