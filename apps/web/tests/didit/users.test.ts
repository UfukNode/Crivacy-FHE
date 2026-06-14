/**
 * Tests for `lib/didit/users` — Sprint 8 name anchor for the
 * address phase.
 *
 * Coverage:
 *   * `parseFullName` — naive last-word split, Unicode preservation,
 *     compound surname handling, fail-closed paths (single token,
 *     empty, whitespace-only, non-string).
 *   * `getDiditUser` — happy path, 404 → null, full_name nullability,
 *     transient error propagation.
 */

import { describe, expect, it } from 'vitest';

import { DiditError, isDiditErrorWithCode } from '@crivacy-fhe/adapter-didit';
import { getDiditUser, parseFullName, type DiditUser } from '@crivacy-fhe/adapter-didit/users';
import type { DiditConfig } from '@crivacy-fhe/adapter-didit/config';
import type { FetchLike, FetchLikeResponse } from '@crivacy-fhe/adapter-didit/http';
import { asDiditWorkflowIdUnchecked } from '@crivacy-fhe/adapter-didit/types';

/* ---------- Fixtures ---------- */

function buildTestConfig(): DiditConfig {
  return Object.freeze({
    apiKey: 'test_api_key',
    baseUrl: 'https://verification.didit.me',
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    retryBaseDelayMs: 50,
    kycWorkflowId: asDiditWorkflowIdUnchecked('11111111-1111-1111-1111-111111111111'),
    addressWorkflowId: asDiditWorkflowIdUnchecked('22222222-2222-2222-2222-222222222222'),
    defaultCallbackUrl: 'https://example.test/callback',
    webhookSecret: 'test_secret',
    webhookDriftSeconds: 300,
    failClosedOnUnknownWorkflow: true,
    proofHashStrict: true,
  }) as DiditConfig;
}

function jsonResponse(status: number, body: unknown): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: async () => JSON.stringify(body),
  };
}

function makeFetch(responses: FetchLikeResponse[]): FetchLike {
  let i = 0;
  return async () => {
    const r = responses[i];
    if (r === undefined) throw new Error(`no response queued for call ${i}`);
    i += 1;
    return r;
  };
}

/* ---------- parseFullName ---------- */

describe('parseFullName', () => {
  it('splits a 3-word name with the last word as last_name', () => {
    const result = parseFullName('John Michael Doe');
    expect(result.firstName).toBe('John Michael');
    expect(result.lastName).toBe('Doe');
  });

  it('handles a 2-word name', () => {
    const result = parseFullName('Jane Doe');
    expect(result.firstName).toBe('Jane');
    expect(result.lastName).toBe('Doe');
  });

  it('handles a compound surname (4 words) — naive split is robust', () => {
    // "Maria Garcia Lopez Smith" — naive split: first="Maria Garcia
    // Lopez", last="Smith". Didit's WRatio fuzzy match concatenates
    // expected_first + expected_last → "Maria Garcia Lopez Smith"
    // for comparison, so the boundary doesn't affect the match.
    const result = parseFullName('Maria Garcia Lopez Smith');
    expect(result.firstName).toBe('Maria Garcia Lopez');
    expect(result.lastName).toBe('Smith');
  });

  it('preserves Unicode (Turkish diacritics)', () => {
    const result = parseFullName('Çağdaş Şükrü Yılmaz');
    expect(result.firstName).toBe('Çağdaş Şükrü');
    expect(result.lastName).toBe('Yılmaz');
  });

  it('preserves Unicode (Spanish ñ + accents)', () => {
    const result = parseFullName('María José Núñez');
    expect(result.firstName).toBe('María José');
    expect(result.lastName).toBe('Núñez');
  });

  it('normalizes excessive internal whitespace', () => {
    const result = parseFullName('John    Michael   Doe');
    expect(result.firstName).toBe('John Michael');
    expect(result.lastName).toBe('Doe');
  });

  it('trims leading/trailing whitespace', () => {
    const result = parseFullName('  John Doe  ');
    expect(result.firstName).toBe('John');
    expect(result.lastName).toBe('Doe');
  });

  it('returns a frozen object', () => {
    const result = parseFullName('John Doe');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('fails closed on a single-word name (Madonna)', () => {
    expect(() => parseFullName('Madonna')).toThrow(DiditError);
    try {
      parseFullName('Madonna');
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_full_name')).toBe(true);
    }
  });

  it('fails closed on empty string', () => {
    try {
      parseFullName('');
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_full_name')).toBe(true);
    }
  });

  it('fails closed on whitespace-only string', () => {
    try {
      parseFullName('   \t   ');
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_full_name')).toBe(true);
    }
  });

  it('fails closed on non-string input', () => {
    try {
      parseFullName(undefined as unknown as string);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_full_name')).toBe(true);
    }
  });
});

/* ---------- getDiditUser ---------- */

describe('getDiditUser', () => {
  it('returns the parsed user on 200', async () => {
    const config = buildTestConfig();
    const fetchImpl = makeFetch([
      jsonResponse(200, {
        vendor_data: 'user-42',
        didit_internal_id: 'abc-internal',
        full_name: 'Maria Garcia Lopez',
        status: 'Approved',
      }),
    ]);
    const user = await getDiditUser(config, 'user-42', fetchImpl);
    expect(user).not.toBeNull();
    expect(user?.fullName).toBe('Maria Garcia Lopez');
    expect(user?.vendorData).toBe('user-42');
    expect(user?.diditInternalId).toBe('abc-internal');
    expect(user?.status).toBe('Approved');
  });

  it('returns null on 404', async () => {
    const config = buildTestConfig();
    const fetchImpl = makeFetch([jsonResponse(404, { error: 'Not found' })]);
    const user = await getDiditUser(config, 'unknown-user', fetchImpl);
    expect(user).toBeNull();
  });

  it('returns user with fullName=null when full_name is null', async () => {
    const config = buildTestConfig();
    const fetchImpl = makeFetch([
      jsonResponse(200, {
        vendor_data: 'user-42',
        full_name: null,
      }),
    ]);
    const user = await getDiditUser(config, 'user-42', fetchImpl);
    expect(user).not.toBeNull();
    expect(user?.fullName).toBeNull();
  });

  it('returns user with fullName=null when full_name is empty string', async () => {
    const config = buildTestConfig();
    const fetchImpl = makeFetch([
      jsonResponse(200, {
        vendor_data: 'user-42',
        full_name: '',
      }),
    ]);
    const user = await getDiditUser(config, 'user-42', fetchImpl);
    expect(user?.fullName).toBeNull();
  });

  it('rejects empty vendor_data with invalid_vendor_data', async () => {
    const config = buildTestConfig();
    const fetchImpl = makeFetch([]);
    try {
      await getDiditUser(config, '', fetchImpl);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_vendor_data')).toBe(true);
    }
  });

  it('returns frozen user object', async () => {
    const config = buildTestConfig();
    const fetchImpl = makeFetch([
      jsonResponse(200, {
        vendor_data: 'user-42',
        full_name: 'John Doe',
      }),
    ]);
    const user = await getDiditUser(config, 'user-42', fetchImpl);
    expect(Object.isFrozen(user)).toBe(true);
  });

  it('propagates non-404 errors (e.g. 500)', async () => {
    const config = buildTestConfig();
    const fetchImpl = makeFetch([jsonResponse(500, { error: 'Internal' })]);
    try {
      await getDiditUser(config, 'user-42', fetchImpl);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DiditError);
      expect(isDiditErrorWithCode(err, 'service_unavailable')).toBe(true);
    }
  });
});

/* ---------- DiditUser type pin ---------- */

describe('DiditUser type', () => {
  it('matches the shape declared in users.ts', () => {
    // Compile-time pin: the DiditUser interface must keep these
    // fields. If a refactor renames a field, this test fails to
    // compile and forces an explicit migration.
    const sample: DiditUser = Object.freeze({
      vendorData: 'user-42',
      diditInternalId: null,
      fullName: 'John Doe',
      status: null,
    });
    expect(sample.vendorData).toBe('user-42');
    expect(sample.fullName).toBe('John Doe');
  });
});
