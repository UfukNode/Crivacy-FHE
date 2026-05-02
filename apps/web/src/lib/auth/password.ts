/**
 * Password hashing + verification (argon2id).
 *
 * Dashboard users (`firm_users`, `admin_users`) authenticate with
 * email + password + TOTP. The password is stored as an argon2id hash
 * using OWASP 2024 defaults: m = 64 MiB, t = 3, p = 4. Those defaults
 * are supplied by `AuthConfig` so tests can lower them to keep the
 * suite fast without touching the production values.
 *
 * `@node-rs/argon2` takes its parameters in the object-form options
 * argument (`memoryCost`, `timeCost`, `parallelism`); the hash string
 * it produces already self-describes those parameters in the standard
 * argon2 encoding (`$argon2id$v=19$m=65536,t=3,p=4$...`), so
 * `verify()` never needs to consult the config — the stored string is
 * authoritative. We only read the config to decide whether an existing
 * hash should be *re-hashed* to pick up raised cost factors.
 *
 * Policy:
 *
 *   * `hashPassword()` enforces `passwordMinLength` up front.
 *   * `verifyPassword()` returns a plain boolean; it never distinguishes
 *     between "wrong password" and "password not set" — that is the
 *     caller's job.
 *   * `needsRehash()` peeks inside the argon2 string and returns true
 *     when any parameter is strictly weaker than the current config.
 *     A successful login that returns `needsRehash === true` causes the
 *     auth service to recompute the hash under the stronger parameters
 *     transparently (see Step 10 routes).
 */

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import type { AuthConfig } from './config';
import { AuthError } from './errors';

/**
 * `@node-rs/argon2` exports `Algorithm` as a `const enum`, which cannot be
 * consumed under `verbatimModuleSyntax`. We reproduce the numeric value
 * here so the call site is still type-safe and explicit. Argon2d = 0,
 * Argon2i = 1, Argon2id = 2 — see the upstream declaration.
 */
const ARGON2_ID = 2 as const;

/* ---------- Types ---------- */

export type PasswordConfig = Pick<
  AuthConfig,
  | 'passwordArgon2MemoryKib'
  | 'passwordArgon2Iterations'
  | 'passwordArgon2Parallelism'
  | 'passwordMinLength'
>;

export interface HashPasswordOptions {
  /** Override `memoryCost` for this single call (tests). */
  readonly memoryCost?: number;
  /** Override `timeCost` for this single call (tests). */
  readonly timeCost?: number;
  /** Override `parallelism` for this single call (tests). */
  readonly parallelism?: number;
}

/* ---------- Hashing ---------- */

/**
 * Hash a plaintext password. Throws `AuthError('weak_password')` if
 * the input is shorter than `config.passwordMinLength` — that is the
 * only policy this module enforces; complexity rules (upper/lower/
 * digit) are deliberately omitted because they do not improve entropy
 * meaningfully and are actively discouraged by NIST SP 800-63B.
 */
export async function hashPassword(
  plaintext: string,
  config: PasswordConfig,
  opts: HashPasswordOptions = {},
): Promise<string> {
  if (typeof plaintext !== 'string') {
    throw new AuthError('weak_password', 'password must be a string');
  }
  if (plaintext.length < config.passwordMinLength) {
    throw new AuthError(
      'weak_password',
      `password must be at least ${config.passwordMinLength} characters`,
    );
  }
  return argonHash(plaintext, {
    algorithm: ARGON2_ID,
    memoryCost: opts.memoryCost ?? config.passwordArgon2MemoryKib,
    timeCost: opts.timeCost ?? config.passwordArgon2Iterations,
    parallelism: opts.parallelism ?? config.passwordArgon2Parallelism,
  });
}

/* ---------- Verification ---------- */

/**
 * Compare a plaintext against a stored argon2id hash string.
 *
 * Parse errors (malformed hash, unrecognized algorithm) are promoted
 * to `AuthError('unsupported_password_hash')` so they surface as a
 * server error, not a failed login.
 */
export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  if (typeof plaintext !== 'string' || typeof storedHash !== 'string') {
    return false;
  }
  try {
    return await argonVerify(storedHash, plaintext);
  } catch (cause) {
    // `@node-rs/argon2` throws on hash strings it cannot parse (wrong
    // prefix, truncated, etc.). Promote to a hard error so monitoring
    // catches a corrupt DB row rather than silently denying access.
    throw new AuthError('unsupported_password_hash', 'stored password hash failed to parse', {
      cause,
    });
  }
}

/* ---------- Rehash detection ---------- */

/**
 * Shape of the parsed argon2id hash string.
 *
 * Example input:
 *
 *     $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
 *
 * The header fields are fixed-position; a missing piece is treated as
 * an unsupported hash.
 */
export interface ParsedArgon2 {
  readonly algorithm: 'argon2id' | 'argon2i' | 'argon2d';
  readonly version: number;
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

const ARGON2_HEADER_PATTERN = /^\$(argon2id|argon2i|argon2d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/;

export function parseArgon2Header(hashString: string): ParsedArgon2 {
  const match = ARGON2_HEADER_PATTERN.exec(hashString);
  if (!match) {
    throw new AuthError('unsupported_password_hash', 'hash is not a valid argon2 string');
  }
  const [, algorithm, version, memoryCost, timeCost, parallelism] = match;
  if (
    algorithm === undefined ||
    version === undefined ||
    memoryCost === undefined ||
    timeCost === undefined ||
    parallelism === undefined
  ) {
    // Unreachable: every capture group in ARGON2_HEADER_PATTERN is
    // mandatory, but the guard keeps strict mode and the lint rules
    // happy without a non-null assertion.
    throw new AuthError(
      'unsupported_password_hash',
      'argon2 header regex produced an incomplete match',
    );
  }
  return {
    algorithm: algorithm as ParsedArgon2['algorithm'],
    version: Number.parseInt(version, 10),
    memoryCost: Number.parseInt(memoryCost, 10),
    timeCost: Number.parseInt(timeCost, 10),
    parallelism: Number.parseInt(parallelism, 10),
  };
}

/**
 * Return true if the stored hash uses parameters weaker than the
 * current config. The caller should, on a successful verify, re-hash
 * the plaintext under the current config and update the row.
 */
export function needsRehash(storedHash: string, config: PasswordConfig): boolean {
  let parsed: ParsedArgon2;
  try {
    parsed = parseArgon2Header(storedHash);
  } catch {
    // Unparseable hash -> pessimistic rehash.
    return true;
  }
  if (parsed.algorithm !== 'argon2id') {
    return true;
  }
  if (parsed.memoryCost < config.passwordArgon2MemoryKib) return true;
  if (parsed.timeCost < config.passwordArgon2Iterations) return true;
  if (parsed.parallelism < config.passwordArgon2Parallelism) return true;
  return false;
}
