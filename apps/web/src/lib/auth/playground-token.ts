/**
 * Playground short-lived bearer tokens.
 *
 * When the dashboard playground proxies a request to the public
 * `/api/v1/*` surface, we can't send the raw API key — the dashboard
 * never stores it. We also can't fake a valid header shape (bcrypt
 * verify would reject it). Instead, the playground handler mints a
 * signed token that names the `apiKeyId` + `firmId` pair, and the
 * `apiRoute` middleware treats a valid token as equivalent to a
 * successful api-key lookup for *that specific key*.
 *
 * Design constraints:
 *
 *   - **Short TTL (120s)**. A leaked token stops working almost
 *     immediately. Playground proxy round-trips are sub-second, so
 *     the window is set by code execution, not UX.
 *   - **HMAC-SHA256**, keyed off `AUTH_JWT_SECRET`. No new secret to
 *     provision; no asymmetric key-management overhead for a
 *     loopback-only token.
 *   - **Version prefix** (`p1`). If the payload format ever changes
 *     (e.g. we add a `scope` field), we bump the version and every
 *     in-flight older token fails verification cleanly.
 *   - **No storage**. Tokens are stateless; no DB row to revoke. The
 *     120s TTL IS the revocation story.
 *
 * The token is **not** a session credential. It does NOT grant any
 * capability beyond "act as this specific api_key for the next 120
 * seconds". All rate limits, scope checks, audit entries, and
 * playground-specific policy (test-mode only, minRole, etc.) still
 * apply downstream.
 *
 * @module
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export class PlaygroundTokenError extends Error {
  readonly code: 'invalid_format' | 'bad_signature' | 'expired' | 'wrong_version';

  constructor(
    code: 'invalid_format' | 'bad_signature' | 'expired' | 'wrong_version',
    message: string,
  ) {
    super(message);
    this.name = 'PlaygroundTokenError';
    this.code = code;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, PlaygroundTokenError);
    }
  }
}

const TOKEN_VERSION = 'p1';
const DEFAULT_TTL_SECONDS = 120;

/** Shape that lives inside the signed payload. */
export interface PlaygroundTokenPayload {
  readonly v: string;
  readonly k: string;
  readonly f: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

function base64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(input: string): string {
  // Re-pad so Node's `base64` decoder accepts it.
  const padLen = (4 - (input.length % 4)) % 4;
  const padded = input + '='.repeat(padLen);
  const normal = padded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normal, 'base64').toString('utf8');
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/**
 * Mint a playground token for the given api key + firm pair.
 * `now` is injected for deterministic tests.
 */
export function createPlaygroundToken(
  input: { readonly apiKeyId: string; readonly firmId: string },
  secret: string,
  now: Date,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: PlaygroundTokenPayload = {
    v: TOKEN_VERSION,
    k: input.apiKeyId,
    f: input.firmId,
    iat,
    exp: iat + ttlSeconds,
    jti: randomUUID(),
  };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const signature = sign(payloadB64, secret);
  return `${payloadB64}.${signature}`;
}

/**
 * Verify a playground token and return its payload, or throw
 * {@link PlaygroundTokenError}. Callers map the error `code` to
 * whatever HTTP response shape they need.
 */
export function verifyPlaygroundToken(
  token: string,
  secret: string,
  now: Date,
): PlaygroundTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new PlaygroundTokenError('invalid_format', 'Playground token is malformed.');
  }
  const [payloadB64, sigB64] = parts;
  if (payloadB64 === undefined || sigB64 === undefined || payloadB64.length === 0 || sigB64.length === 0) {
    throw new PlaygroundTokenError('invalid_format', 'Playground token is malformed.');
  }

  const expected = sign(payloadB64, secret);
  // timingSafeEqual requires equal-length buffers; bail on length mismatch
  // before the compare so we don't throw a TypeError.
  const sigBuf = Buffer.from(sigB64, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new PlaygroundTokenError('bad_signature', 'Playground token signature is invalid.');
  }

  let payload: PlaygroundTokenPayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64)) as PlaygroundTokenPayload;
  } catch {
    throw new PlaygroundTokenError('invalid_format', 'Playground token payload is not valid JSON.');
  }

  if (payload.v !== TOKEN_VERSION) {
    throw new PlaygroundTokenError('wrong_version', 'Playground token version is not supported.');
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (payload.exp <= nowSeconds) {
    throw new PlaygroundTokenError('expired', 'Playground token has expired.');
  }

  return payload;
}

/**
 * HTTP header name the playground handler sets and the `apiRoute`
 * middleware reads. Exported as a constant so both sides can import
 * the same string.
 */
export const PLAYGROUND_TOKEN_HEADER = 'x-crivacy-playground-token';
