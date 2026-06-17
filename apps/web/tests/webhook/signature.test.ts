/**
 * Tests for webhook HMAC-SHA256 signing.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DELIVERY_ID_HEADER,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  WebhookError,
  buildSignedPayload,
  buildWebhookHeaders,
  computeHmac,
  parseSignatureHeader,
  signWebhookPayload,
  verifyWebhookSignature,
} from '@/lib/webhook';

import {
  FIXTURE_DELIVERY_ID,
  FIXTURE_EVENT_ID,
  FIXTURE_SIGNING_SECRET,
  FIXTURE_TIMESTAMP,
} from './fixtures';

const TEST_BODY = '{"type":"credential.created","data":{}}';

describe('buildSignedPayload', () => {
  it('concatenates timestamp and body with a dot', () => {
    expect(buildSignedPayload(1234567890, 'hello')).toBe('1234567890.hello');
  });

  it('throws on zero timestamp', () => {
    expect(() => buildSignedPayload(0, 'body')).toThrow(WebhookError);
  });

  it('throws on negative timestamp', () => {
    expect(() => buildSignedPayload(-1, 'body')).toThrow(WebhookError);
  });

  it('throws on non-integer timestamp', () => {
    expect(() => buildSignedPayload(1.5, 'body')).toThrow(WebhookError);
  });
});

describe('computeHmac', () => {
  it('produces correct HMAC-SHA256', () => {
    const expected = createHmac('sha256', FIXTURE_SIGNING_SECRET)
      .update(`${FIXTURE_TIMESTAMP}.${TEST_BODY}`, 'utf8')
      .digest('hex');
    const result = computeHmac(FIXTURE_SIGNING_SECRET, `${FIXTURE_TIMESTAMP}.${TEST_BODY}`);
    expect(result).toBe(expected);
  });

  it('produces 64-char hex string', () => {
    const result = computeHmac('secret', 'payload');
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on empty secret', () => {
    expect(() => computeHmac('', 'payload')).toThrow(WebhookError);
  });
});

describe('signWebhookPayload', () => {
  it('produces Stripe-style signature header', () => {
    const result = signWebhookPayload(FIXTURE_SIGNING_SECRET, TEST_BODY, FIXTURE_TIMESTAMP);
    expect(result).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(result).toContain(`t=${FIXTURE_TIMESTAMP}`);
  });
});

describe('parseSignatureHeader', () => {
  it('parses valid header', () => {
    const sig = signWebhookPayload(FIXTURE_SIGNING_SECRET, TEST_BODY, FIXTURE_TIMESTAMP);
    const parsed = parseSignatureHeader(sig);
    expect(parsed).not.toBeNull();
    expect(parsed?.timestamp).toBe(FIXTURE_TIMESTAMP);
    expect(parsed?.v1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null for malformed header', () => {
    expect(parseSignatureHeader('garbage')).toBeNull();
    expect(parseSignatureHeader('')).toBeNull();
    expect(parseSignatureHeader('t=abc,v1=def')).toBeNull();
  });

  it('returns null for missing t=', () => {
    expect(
      parseSignatureHeader('v1=abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234'),
    ).toBeNull();
  });

  it('returns null for missing v1=', () => {
    expect(parseSignatureHeader('t=1234567890')).toBeNull();
  });

  it('returns null for v1 with wrong length', () => {
    expect(parseSignatureHeader('t=1234567890,v1=short')).toBeNull();
  });
});

describe('verifyWebhookSignature', () => {
  it('verifies a valid signature', () => {
    const sig = signWebhookPayload(FIXTURE_SIGNING_SECRET, TEST_BODY, FIXTURE_TIMESTAMP);
    const result = verifyWebhookSignature(
      FIXTURE_SIGNING_SECRET,
      TEST_BODY,
      sig,
      300,
      FIXTURE_TIMESTAMP,
    );
    expect(result).toBe(true);
  });

  it('rejects wrong secret', () => {
    const sig = signWebhookPayload(FIXTURE_SIGNING_SECRET, TEST_BODY, FIXTURE_TIMESTAMP);
    expect(verifyWebhookSignature('wrong-secret', TEST_BODY, sig, 300, FIXTURE_TIMESTAMP)).toBe(
      false,
    );
  });

  it('rejects tampered body', () => {
    const sig = signWebhookPayload(FIXTURE_SIGNING_SECRET, TEST_BODY, FIXTURE_TIMESTAMP);
    expect(
      verifyWebhookSignature(FIXTURE_SIGNING_SECRET, 'tampered', sig, 300, FIXTURE_TIMESTAMP),
    ).toBe(false);
  });

  it('rejects stale timestamp', () => {
    const sig = signWebhookPayload(FIXTURE_SIGNING_SECRET, TEST_BODY, FIXTURE_TIMESTAMP);
    // Now is 10 minutes later — beyond 5 minute tolerance
    const futureNow = FIXTURE_TIMESTAMP + 600;
    expect(verifyWebhookSignature(FIXTURE_SIGNING_SECRET, TEST_BODY, sig, 300, futureNow)).toBe(
      false,
    );
  });

  it('accepts timestamp within tolerance', () => {
    const sig = signWebhookPayload(FIXTURE_SIGNING_SECRET, TEST_BODY, FIXTURE_TIMESTAMP);
    const futureNow = FIXTURE_TIMESTAMP + 299;
    expect(verifyWebhookSignature(FIXTURE_SIGNING_SECRET, TEST_BODY, sig, 300, futureNow)).toBe(
      true,
    );
  });

  it('rejects malformed header', () => {
    expect(
      verifyWebhookSignature(FIXTURE_SIGNING_SECRET, TEST_BODY, 'garbage', 300, FIXTURE_TIMESTAMP),
    ).toBe(false);
  });
});

describe('buildWebhookHeaders', () => {
  it('includes all required headers', () => {
    const headers = buildWebhookHeaders(
      FIXTURE_SIGNING_SECRET,
      TEST_BODY,
      FIXTURE_EVENT_ID,
      FIXTURE_DELIVERY_ID,
      FIXTURE_TIMESTAMP,
    );

    expect(headers['content-type']).toBe('application/json');
    expect(headers[SIGNATURE_HEADER]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(headers[EVENT_ID_HEADER]).toBe(FIXTURE_EVENT_ID);
    expect(headers[DELIVERY_ID_HEADER]).toBe(FIXTURE_DELIVERY_ID);
    expect(headers['user-agent']).toBe('Crivacy-Webhook/1.0');
  });
});
