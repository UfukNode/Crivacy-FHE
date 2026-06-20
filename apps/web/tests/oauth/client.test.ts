// @vitest-environment node
/**
 * OAuth client credential + redirect URI tests.
 *
 * Every OAuth redirect hijack CVE started with relaxing the
 * redirect_uri match rule. The rules codified in
 * `validateRedirectUri` — exact match, no fragments, no userinfo,
 * https-only (with the loopback exception) — are non-negotiable;
 * these tests pin them down.
 */

import { describe, expect, it } from 'vitest';

import {
  CLIENT_ID_LIVE_PREFIX,
  CLIENT_ID_TEST_PREFIX,
  generateClientId,
  generateClientSecret,
  hashClientSecret,
  validateRedirectUri,
  verifyClientSecret,
} from '@/lib/oauth/client';

describe('oauth/client — generateClientId', () => {
  it('uses the live prefix in live mode', () => {
    const id = generateClientId('live');
    expect(id.startsWith(CLIENT_ID_LIVE_PREFIX)).toBe(true);
  });

  it('uses the test prefix in test mode', () => {
    const id = generateClientId('test');
    expect(id.startsWith(CLIENT_ID_TEST_PREFIX)).toBe(true);
  });

  it('produces ≥ 24 random chars beyond the prefix', () => {
    const id = generateClientId('live');
    const body = id.slice(CLIENT_ID_LIVE_PREFIX.length);
    expect(body.length).toBeGreaterThanOrEqual(24);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates unique ids across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(generateClientId('live'));
    expect(seen.size).toBe(200);
  });
});

describe('oauth/client — generateClientSecret + hashClientSecret', () => {
  it('round-trips: verifyClientSecret accepts the raw secret against its argon2id hash', async () => {
    const raw = generateClientSecret();
    const hashed = await hashClientSecret(raw);
    expect(hashed).not.toBe(raw);
    expect(hashed.startsWith('$argon2')).toBe(true);
    expect(await verifyClientSecret(raw, hashed)).toBe(true);
  });

  it('verifyClientSecret rejects a tampered raw secret', async () => {
    const raw = generateClientSecret();
    const hashed = await hashClientSecret(raw);
    const tampered = raw.slice(0, -1) + (raw.at(-1) === 'A' ? 'B' : 'A');
    expect(await verifyClientSecret(tampered, hashed)).toBe(false);
  });

  it('verifyClientSecret returns false (not throws) on a malformed stored hash', async () => {
    expect(await verifyClientSecret('anything', 'not-an-argon2-hash')).toBe(false);
  });
});

describe('oauth/client — validateRedirectUri', () => {
  const whitelist = [
    'https://app.example.com/oauth/callback',
    'https://admin.example.com:8443/return',
    'http://localhost:3000/callback',
  ];

  it('accepts an exact match', () => {
    expect(validateRedirectUri('https://app.example.com/oauth/callback', whitelist)).toEqual({
      ok: true,
    });
  });

  it('treats default ports as canonically equal', () => {
    expect(
      validateRedirectUri('https://app.example.com:443/oauth/callback', whitelist),
    ).toEqual({ ok: true });
  });

  it('rejects a trailing-slash mismatch (the canonical path must match)', () => {
    const r = validateRedirectUri('https://app.example.com/oauth/callback/', whitelist);
    expect(r.ok).toBe(false);
  });

  it('rejects a different subdomain', () => {
    const r = validateRedirectUri('https://evil.example.com/oauth/callback', whitelist);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-whitelisted path', () => {
    const r = validateRedirectUri('https://app.example.com/oauth/pwn', whitelist);
    expect(r.ok).toBe(false);
  });

  it('rejects a URL with a fragment identifier', () => {
    const r = validateRedirectUri('https://app.example.com/oauth/callback#steal', whitelist);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('fragment');
  });

  it('rejects URLs carrying userinfo (user@host)', () => {
    const r = validateRedirectUri('https://attacker@app.example.com/oauth/callback', whitelist);
    expect(r.ok).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    expect(validateRedirectUri('javascript:alert(1)', whitelist).ok).toBe(false);
    expect(validateRedirectUri('data:text/html,<script>', whitelist).ok).toBe(false);
    expect(validateRedirectUri('ftp://app.example.com/cb', whitelist).ok).toBe(false);
  });

  it('rejects http for non-loopback hosts', () => {
    const r = validateRedirectUri('http://app.example.com/oauth/callback', whitelist);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('https');
  });

  it('accepts http for localhost (dev exception)', () => {
    expect(validateRedirectUri('http://localhost:3000/callback', whitelist)).toEqual({
      ok: true,
    });
  });

  it('rejects a syntactically invalid URL', () => {
    const r = validateRedirectUri('not a url', whitelist);
    expect(r.ok).toBe(false);
  });

  it('rejects when the whitelist is empty', () => {
    const r = validateRedirectUri('https://app.example.com/oauth/callback', []);
    expect(r.ok).toBe(false);
  });

  it('query-string byte-for-byte match is required', () => {
    const list = ['https://app.example.com/cb?mode=live'];
    expect(validateRedirectUri('https://app.example.com/cb?mode=live', list).ok).toBe(true);
    expect(validateRedirectUri('https://app.example.com/cb?mode=test', list).ok).toBe(false);
    expect(validateRedirectUri('https://app.example.com/cb', list).ok).toBe(false);
  });

  it('malformed whitelist entries are skipped, not fatal (still matches other entries)', () => {
    const mixed = ['not-a-url', 'https://app.example.com/cb'];
    expect(validateRedirectUri('https://app.example.com/cb', mixed)).toEqual({ ok: true });
  });
});
