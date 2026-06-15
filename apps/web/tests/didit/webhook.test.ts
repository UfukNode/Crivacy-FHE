/**
 * Tests for the webhook signature verification layer.
 *
 * Every failure mode maps to a dedicated `DiditErrorCode` so the
 * route handler can branch on a single field. Order matters:
 *
 *   1. `missing_timestamp`    — X-Timestamp absent
 *   2. stale/invalid shape    — X-Timestamp present but garbage
 *   3. `stale_signature`      — timestamp outside drift window
 *   4. `missing_signature`    — no V2 and no Simple header
 *   5. `invalid_signature`    — headers present, HMAC did not match
 *   6. `invalid_webhook_body` — body failed Zod parse
 *
 * We drive everything through the deterministic `fixtureClock` so
 * freshness assertions stay stable.
 */

import { describe, expect, it } from 'vitest';

import { DiditError, isDiditErrorWithCode, parseWebhookBody, verifyWebhook } from '@crivacy-fhe/adapter-didit';

import {
  FIXTURE_NOW_SECONDS,
  FIXTURE_WEBHOOK_SECRET,
  buildSignedWebhookInput,
  buildTestConfig,
  buildWebhookBody,
  fixtureClock,
  signWebhookSimple,
  signWebhookV2,
} from './fixtures';

/* ---------- parseWebhookBody ---------- */

describe('parseWebhookBody', () => {
  it('accepts a canonical body', () => {
    const parsed = parseWebhookBody(buildWebhookBody());
    expect(parsed.status).toBe('Approved');
  });

  it('throws invalid_webhook_body on a missing required field', () => {
    const body = buildWebhookBody();
    Reflect.deleteProperty(body as Record<string, unknown>, 'session_id');
    expect(() => parseWebhookBody(body)).toThrow(DiditError);
    try {
      parseWebhookBody(body);
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_webhook_body')).toBe(true);
      const context = (err as DiditError).context ?? {};
      expect(Array.isArray((context as Record<string, unknown>)['issues'])).toBe(true);
    }
  });

  it('rejects a non-object body', () => {
    expect(() => parseWebhookBody('oops')).toThrow(DiditError);
    expect(() => parseWebhookBody(null)).toThrow(DiditError);
    expect(() => parseWebhookBody(42)).toThrow(DiditError);
  });
});

/* ---------- verifyWebhook — timestamp ---------- */

describe('verifyWebhook — timestamp', () => {
  it('throws missing_timestamp when X-Timestamp is absent', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody();
    const input = buildSignedWebhookInput(FIXTURE_WEBHOOK_SECRET, body, {
      'x-timestamp': undefined,
    });

    expect(() => verifyWebhook(config, input, fixtureClock)).toThrow(DiditError);
    try {
      verifyWebhook(config, input, fixtureClock);
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'missing_timestamp')).toBe(true);
    }
  });

  it('throws missing_timestamp on an empty X-Timestamp string', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody();
    const input = buildSignedWebhookInput(FIXTURE_WEBHOOK_SECRET, body, {
      'x-timestamp': '',
    });

    expect(() => verifyWebhook(config, input, fixtureClock)).toThrow(DiditError);
  });

  it('throws invalid_signature when X-Timestamp is not an integer', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody();
    const input = buildSignedWebhookInput(FIXTURE_WEBHOOK_SECRET, body, {
      'x-timestamp': 'yesterday',
    });

    try {
      verifyWebhook(config, input, fixtureClock);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_signature')).toBe(true);
    }
  });

  it('throws stale_signature when the timestamp is too old', () => {
    const config = buildTestConfig({ DIDIT_WEBHOOK_DRIFT_SECONDS: '60' });
    const body = buildWebhookBody();
    const signature = signWebhookV2(FIXTURE_WEBHOOK_SECRET, body);
    const input = {
      body,
      headers: {
        'x-signature-v2': signature,
        'x-timestamp': String(FIXTURE_NOW_SECONDS - 120),
      },
    };

    try {
      verifyWebhook(config, input, fixtureClock);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'stale_signature')).toBe(true);
    }
  });

  it('throws stale_signature when the timestamp is too far in the future', () => {
    const config = buildTestConfig({ DIDIT_WEBHOOK_DRIFT_SECONDS: '60' });
    const body = buildWebhookBody();
    const signature = signWebhookV2(FIXTURE_WEBHOOK_SECRET, body);
    const input = {
      body,
      headers: {
        'x-signature-v2': signature,
        'x-timestamp': String(FIXTURE_NOW_SECONDS + 120),
      },
    };

    expect(() => verifyWebhook(config, input, fixtureClock)).toThrow(DiditError);
  });

  it('accepts a timestamp exactly at the drift boundary', () => {
    const config = buildTestConfig({ DIDIT_WEBHOOK_DRIFT_SECONDS: '60' });
    // body.timestamp must mirror the X-Timestamp under test — the
    // AUD-INT-REPLAY-001 fix cross-checks the two, so the drift-
    // boundary scenario still has to carry a consistent pair.
    const driftIso = new Date((FIXTURE_NOW_SECONDS - 60) * 1000).toISOString();
    const body = buildWebhookBody({ timestamp: driftIso });
    const signature = signWebhookV2(FIXTURE_WEBHOOK_SECRET, body);
    const input = {
      body,
      headers: {
        'x-signature-v2': signature,
        'x-timestamp': String(FIXTURE_NOW_SECONDS - 60),
      },
    };
    const result = verifyWebhook(config, input, fixtureClock);
    expect(result.timestamp).toBe(FIXTURE_NOW_SECONDS - 60);
  });

  it('rejects when body.timestamp does not match X-Timestamp header (AUD-INT-REPLAY-001)', () => {
    // Replay-forge scenario: attacker captured a valid webhook with
    // body.timestamp = T0, then re-sends it with a forged fresh
    // X-Timestamp header to bypass the drift window. Signature
    // still verifies (body unchanged); the body/header consistency
    // check must flag the mismatch.
    const config = buildTestConfig({ DIDIT_WEBHOOK_DRIFT_SECONDS: '60' });
    const originalIso = new Date((FIXTURE_NOW_SECONDS - 3600) * 1000).toISOString();
    const body = buildWebhookBody({ timestamp: originalIso });
    const signature = signWebhookV2(FIXTURE_WEBHOOK_SECRET, body);
    const input = {
      body,
      headers: {
        'x-signature-v2': signature,
        // Forged: header says "now" but body.timestamp is 1h old.
        'x-timestamp': String(FIXTURE_NOW_SECONDS),
      },
    };
    try {
      verifyWebhook(config, input, fixtureClock);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'timestamp_mismatch')).toBe(true);
    }
  });
});

/* ---------- verifyWebhook — signature headers ---------- */

describe('verifyWebhook — signature presence', () => {
  it('throws missing_signature when neither header is present', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody();
    const input = {
      body,
      headers: { 'x-timestamp': String(FIXTURE_NOW_SECONDS) },
    };

    try {
      verifyWebhook(config, input, fixtureClock);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'missing_signature')).toBe(true);
    }
  });

  it('throws missing_signature when both headers are empty strings', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody();
    const input = {
      body,
      headers: {
        'x-timestamp': String(FIXTURE_NOW_SECONDS),
        'x-signature-v2': '',
        'x-signature-simple': '',
      },
    };

    expect(() => verifyWebhook(config, input, fixtureClock)).toThrow(DiditError);
  });
});

/* ---------- verifyWebhook — V2 signature ---------- */

describe('verifyWebhook — V2 signature', () => {
  it('accepts a valid V2 signature + returns the parsed body', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody();
    const input = buildSignedWebhookInput(FIXTURE_WEBHOOK_SECRET, body);

    const result = verifyWebhook(config, input, fixtureClock);
    expect(result.scheme).toBe('v2');
    expect(result.timestamp).toBe(FIXTURE_NOW_SECONDS);
    expect(result.body.session_id).toBe((body as Record<string, unknown>)['session_id'] as string);
  });

  it('throws invalid_signature when the V2 HMAC is wrong', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody();
    const input = buildSignedWebhookInput(FIXTURE_WEBHOOK_SECRET, body, {
      'x-signature-v2': 'a'.repeat(64),
    });

    try {
      verifyWebhook(config, input, fixtureClock);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_signature')).toBe(true);
    }
  });

  it('throws invalid_signature when signed against a different secret', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody();
    const wrongSignature = signWebhookV2('some_other_secret_xxxxxxxxxx', body);
    const input = {
      body,
      headers: {
        'x-signature-v2': wrongSignature,
        'x-timestamp': String(FIXTURE_NOW_SECONDS),
      },
    };

    expect(() => verifyWebhook(config, input, fixtureClock)).toThrow(DiditError);
  });

  it('is order-insensitive on body keys (canonical JSON)', () => {
    const config = buildTestConfig();
    const bodyA = buildWebhookBody();
    // Build a key-reordered version of the same body.
    const bodyB: Record<string, unknown> = {};
    const keys = Object.keys(bodyA).sort().reverse();
    for (const k of keys) {
      bodyB[k] = (bodyA as Record<string, unknown>)[k];
    }
    // Sign bodyA, but send bodyB — canonicalJson produces the same
    // byte string so the HMAC still matches.
    const input = buildSignedWebhookInput(FIXTURE_WEBHOOK_SECRET, bodyA);
    const result = verifyWebhook(config, { body: bodyB, headers: input.headers }, fixtureClock);
    expect(result.scheme).toBe('v2');
  });

  it('is length-insensitive on the signature comparison', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody();
    // Signature shorter than expected — should not crash, just reject.
    const input = {
      body,
      headers: {
        'x-signature-v2': 'deadbeef',
        'x-timestamp': String(FIXTURE_NOW_SECONDS),
      },
    };
    expect(() => verifyWebhook(config, input, fixtureClock)).toThrow(DiditError);
  });
});

/* ---------- verifyWebhook — Simple fallback ---------- */

describe('verifyWebhook — Simple fallback', () => {
  it('accepts a valid Simple signature when V2 is absent', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody({ timestamp: 'ts-string-1' });
    const signature = signWebhookSimple(FIXTURE_WEBHOOK_SECRET, body);
    const input = {
      body,
      headers: {
        'x-signature-simple': signature,
        'x-timestamp': String(FIXTURE_NOW_SECONDS),
      },
    };

    const result = verifyWebhook(config, input, fixtureClock);
    expect(result.scheme).toBe('simple');
  });

  it('prefers V2 over Simple when both are present and valid', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody({ timestamp: 'ts-string-2' });
    const v2 = signWebhookV2(FIXTURE_WEBHOOK_SECRET, body);
    const simple = signWebhookSimple(FIXTURE_WEBHOOK_SECRET, body);
    const input = {
      body,
      headers: {
        'x-signature-v2': v2,
        'x-signature-simple': simple,
        'x-timestamp': String(FIXTURE_NOW_SECONDS),
      },
    };

    const result = verifyWebhook(config, input, fixtureClock);
    expect(result.scheme).toBe('v2');
  });

  it('falls back to Simple when V2 is wrong but Simple is right', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody({ timestamp: 'ts-string-3' });
    const simple = signWebhookSimple(FIXTURE_WEBHOOK_SECRET, body);
    const input = {
      body,
      headers: {
        'x-signature-v2': 'f'.repeat(64),
        'x-signature-simple': simple,
        'x-timestamp': String(FIXTURE_NOW_SECONDS),
      },
    };

    const result = verifyWebhook(config, input, fixtureClock);
    expect(result.scheme).toBe('simple');
  });

  it('throws invalid_signature when both schemes are wrong', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody();
    const input = {
      body,
      headers: {
        'x-signature-v2': 'f'.repeat(64),
        'x-signature-simple': '0'.repeat(64),
        'x-timestamp': String(FIXTURE_NOW_SECONDS),
      },
    };

    try {
      verifyWebhook(config, input, fixtureClock);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_signature')).toBe(true);
      const context = (err as DiditError).context ?? {};
      const schemePresent = (context as Record<string, unknown>)['schemePresent'] as
        | Record<string, boolean>
        | undefined;
      expect(schemePresent?.['v2']).toBe(true);
      expect(schemePresent?.['simple']).toBe(true);
    }
  });
});

/* ---------- verifyWebhook — body validation ---------- */

describe('verifyWebhook — body validation', () => {
  it('throws invalid_webhook_body when the schema fails after HMAC passes', () => {
    const config = buildTestConfig();
    // Status is now `z.string().min(1).max(64)` (forward-compatible — see DC1).
    // An empty status still violates the schema; use that to trigger the
    // post-HMAC parse failure path.
    const badBody = {
      ...buildWebhookBody(),
      status: '',
    };
    const input = buildSignedWebhookInput(FIXTURE_WEBHOOK_SECRET, badBody);

    try {
      verifyWebhook(config, input, fixtureClock);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_webhook_body')).toBe(true);
    }
  });

  it('returns a frozen result on success', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody();
    const input = buildSignedWebhookInput(FIXTURE_WEBHOOK_SECRET, body);

    const result = verifyWebhook(config, input, fixtureClock);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

/* ---------- verifyWebhook — header casing ---------- */

describe('verifyWebhook — header extraction', () => {
  it('is case-sensitive on lowercased keys (caller normalizes)', () => {
    // The function expects lowercased keys. Upper-case keys are
    // treated as absent — verifying our contract.
    const config = buildTestConfig();
    const body = buildWebhookBody();
    const signature = signWebhookV2(FIXTURE_WEBHOOK_SECRET, body);
    const input = {
      body,
      headers: {
        'X-Signature-V2': signature,
        'X-Timestamp': String(FIXTURE_NOW_SECONDS),
      },
    };

    expect(() => verifyWebhook(config, input, fixtureClock)).toThrow(DiditError);
  });

  it('trims whitespace around header values', () => {
    const config = buildTestConfig();
    const body = buildWebhookBody();
    const signature = signWebhookV2(FIXTURE_WEBHOOK_SECRET, body);
    const input = {
      body,
      headers: {
        'x-signature-v2': `  ${signature}  `,
        'x-timestamp': `  ${FIXTURE_NOW_SECONDS}  `,
      },
    };

    const result = verifyWebhook(config, input, fixtureClock);
    expect(result.scheme).toBe('v2');
  });
});
