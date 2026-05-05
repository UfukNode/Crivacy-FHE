/**
 * Request context capture for audit rows.
 *
 * Every privileged action is written with the HTTP request context
 * attached (ip, user agent, request id) so incident response can
 * reconstruct who did what from which client. The middleware layer
 * populates an `AuditRequestContext` value object on the per-request
 * `RequestContext` and hands it to the route handler; the handler
 * passes it unchanged to the writer.
 *
 * This module is **pure** — no framework bindings. The Next.js
 * middleware glue that extracts the fields from `NextRequest` lives
 * in `src/server/middleware/audit.ts` (step 10).
 *
 * Validation rules:
 *
 *   * `ip` — accepts IPv4 dotted-quad or IPv6 (compressed or long).
 *     The check is structural, not exhaustive; the network layer
 *     already validated the packet and we just want to reject
 *     obvious garbage before `INSERT`.
 *   * `userAgent` — truncated to 1024 characters to prevent abuse.
 *   * `requestId` — uuid v4. Upstream middleware generates it if the
 *     caller did not supply an `X-Request-Id` header.
 */

import { AuditError } from './errors';

/** Value object stored on the per-request context and consumed by the writer. */
export interface AuditRequestContext {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

/** A context with every field set to null. Used by system actors. */
export const EMPTY_CONTEXT: AuditRequestContext = Object.freeze({
  ip: null,
  userAgent: null,
  requestId: null,
});

/** Upper bound mirror of `audit_log.user_agent` — the column is `text` but we still clamp. */
export const MAX_USER_AGENT_LENGTH = 1024;

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// IPv4 dotted-quad with per-octet 0-255 validation.
const IPV4_REGEX =
  /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/;

// IPv6 (full, compressed, and IPv4-mapped). The regex is permissive
// on purpose — we accept anything that looks like an address and let
// the Postgres `text` column store it verbatim.
const IPV6_REGEX =
  /^(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|:(?::[0-9a-f]{1,4}){1,7}|::|::(?:ffff(?::0{1,4})?:)?(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))$/i;

function isValidIp(value: string): boolean {
  return IPV4_REGEX.test(value) || IPV6_REGEX.test(value);
}

/**
 * Build a validated context. Pass `undefined` or an empty string for
 * any field you don't have — the writer will persist `null`.
 */
export function buildRequestContext(input: {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}): AuditRequestContext {
  const ip = normalizeIp(input.ip);
  const userAgent = normalizeUserAgent(input.userAgent);
  const requestId = normalizeRequestId(input.requestId);
  return Object.freeze({ ip, userAgent, requestId });
}

function normalizeIp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Strip zone identifier if present ("fe80::1%eth0" → "fe80::1").
  const withoutZone = trimmed.replace(/%[^%]*$/, '');
  if (!isValidIp(withoutZone)) {
    throw new AuditError('invalid_context', 'ip is not a valid IPv4 or IPv6 address', {
      context: { received: trimmed },
    });
  }
  return withoutZone;
}

function normalizeUserAgent(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_USER_AGENT_LENGTH) {
    return trimmed.slice(0, MAX_USER_AGENT_LENGTH);
  }
  return trimmed;
}

function normalizeRequestId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!UUID_V4_REGEX.test(trimmed)) {
    throw new AuditError('invalid_context', 'requestId must be a uuid v4 or null', {
      context: { received: trimmed },
    });
  }
  return trimmed;
}
