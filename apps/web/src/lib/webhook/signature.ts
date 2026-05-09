/**
 * Outbound webhook HMAC-SHA256 signing — Stripe-style.
 *
 * PLAN.md §8: `X-Crivacy-Signature: t=<unix>,v1=<hex hmac>`
 * HMAC-SHA256(secret, `${t}.${body}`)
 *
 * @module
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { WebhookError } from './errors';

/* ---------- Header constants ---------- */

/** Header carrying the HMAC signature. */
export const SIGNATURE_HEADER = 'x-crivacy-signature';

/** Header carrying the unique event id for idempotency. */
export const EVENT_ID_HEADER = 'x-crivacy-event-id';

/** Header carrying the delivery id. */
export const DELIVERY_ID_HEADER = 'x-crivacy-delivery-id';

/** Default signature tolerance window in seconds (5 minutes). */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/* ---------- Signing ---------- */

/**
 * Build the signed payload string that HMAC is computed over.
 * Format: `${unixTimestamp}.${body}`
 */
export function buildSignedPayload(timestamp: number, body: string): string {
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new WebhookError(
      'invalid_signature_input',
      `Timestamp must be a positive integer, got ${timestamp}.`,
    );
  }
  return `${timestamp}.${body}`;
}

/**
 * Compute HMAC-SHA256 of the signed payload.
 *
 * @param secret - Raw signing secret (UTF-8 string)
 * @param payload - The signed payload string (`${timestamp}.${body}`)
 * @returns Hex-encoded HMAC
 */
export function computeHmac(secret: string, payload: string): string {
  if (secret.length === 0) {
    throw new WebhookError('invalid_signature_input', 'Signing secret must not be empty.');
  }
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * Build the full `X-Crivacy-Signature` header value.
 *
 * Format: `t=<unix>,v1=<hex hmac>`
 *
 * @param secret - Raw signing secret
 * @param body - Serialized JSON body
 * @param timestamp - Unix timestamp (seconds)
 * @returns Header value string
 */
export function signWebhookPayload(secret: string, body: string, timestamp: number): string {
  const signedPayload = buildSignedPayload(timestamp, body);
  const hmac = computeHmac(secret, signedPayload);
  return `t=${timestamp},v1=${hmac}`;
}

/**
 * Parse a `X-Crivacy-Signature` header into its components.
 *
 * @returns Parsed timestamp and v1 HMAC, or null if malformed.
 */
export function parseSignatureHeader(header: string): { timestamp: number; v1: string } | null {
  const parts = header.split(',');
  let timestamp: number | undefined;
  let v1: string | undefined;

  for (const part of parts) {
    const [key, ...rest] = part.split('=');
    const value = rest.join('=');
    if (key === 't') {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        timestamp = parsed;
      }
    } else if (key === 'v1') {
      if (/^[0-9a-f]{64}$/.test(value)) {
        v1 = value;
      }
    }
  }

  if (timestamp === undefined || v1 === undefined) {
    return null;
  }

  return { timestamp, v1 };
}

/**
 * Verify an incoming webhook signature. Used by firms to verify
 * that a payload truly came from Crivacy.
 *
 * @param secret - Raw signing secret
 * @param body - Raw request body (string)
 * @param signatureHeader - Value of `X-Crivacy-Signature`
 * @param toleranceSeconds - Max acceptable age in seconds (default 300)
 * @param now - Current Unix timestamp in seconds
 * @returns true if signature is valid and within tolerance
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  signatureHeader: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
  now?: number,
): boolean {
  const parsed = parseSignatureHeader(signatureHeader);
  if (parsed === null) return false;

  const currentTime = now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - parsed.timestamp) > toleranceSeconds) {
    return false;
  }

  const expected = computeHmac(secret, buildSignedPayload(parsed.timestamp, body));

  // Constant-time comparison
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(parsed.v1, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Build the full set of outbound webhook headers.
 */
export function buildWebhookHeaders(
  secret: string,
  body: string,
  eventId: string,
  deliveryId: string,
  timestamp: number,
): Record<string, string> {
  const signature = signWebhookPayload(secret, body, timestamp);
  return {
    'content-type': 'application/json',
    [SIGNATURE_HEADER]: signature,
    [EVENT_ID_HEADER]: eventId,
    [DELIVERY_ID_HEADER]: deliveryId,
    'user-agent': 'Crivacy-Webhook/1.0',
  };
}
