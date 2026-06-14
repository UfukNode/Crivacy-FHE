// @vitest-environment node
/**
 * Pwned Passwords lookup — k-anonymity + fail-open contract.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  checkPasswordPwned,
  assertPasswordNotPwned,
  PwnedPasswordError,
} from '@/lib/auth/pwned-passwords';

function mockFetchReturning(status: number, body: string): typeof fetch {
  return vi.fn(async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }) as unknown as Response,
  ) as unknown as typeof fetch;
}

function mockFetchThrowing(err: Error): typeof fetch {
  return vi.fn(async () => {
    throw err;
  }) as unknown as typeof fetch;
}

describe('checkPasswordPwned — k-anonymity', () => {
  it('sends only the first 5 hex characters of the SHA-1 digest', async () => {
    // SHA-1 of "P@ssw0rd" = 21bd12dc183f740ee76f27b78eb39c8ad972a757 (uppercase).
    // Prefix: 21BD1. API should be hit with /range/21BD1 and NEVER
    // receive the full digest.
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => '',
        }) as unknown as Response,
    ) as unknown as typeof fetch;

    await checkPasswordPwned('P@ssw0rd', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = (fetchImpl as unknown as { mock: { calls: [string, unknown][] } }).mock.calls[0]!;
    expect(url).toBe('https://api.pwnedpasswords.com/range/21BD1');
  });

  it('returns pwned=true and the real count when the remaining suffix is found', async () => {
    // "P@ssw0rd" has a well-known breach count. We stub a response
    // that includes a matching suffix at count 9999. The suffix for
    // "P@ssw0rd" is 2DC183F740EE76F27B78EB39C8AD972A757.
    const body = [
      '000000000000000000000000000000000AA:1',
      '2DC183F740EE76F27B78EB39C8AD972A757:9999',
      'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:3',
    ].join('\r\n');
    const fetchImpl = mockFetchReturning(200, body);

    const result = await checkPasswordPwned('P@ssw0rd', { fetchImpl });

    expect(result).toEqual({ pwned: true, count: 9999, checked: true });
  });

  it('returns pwned=false when the suffix is not in the bucket', async () => {
    const body = ['000000000000000000000000000000000AA:1'].join('\r\n');
    const fetchImpl = mockFetchReturning(200, body);

    const result = await checkPasswordPwned('something-totally-novel', { fetchImpl });

    expect(result.pwned).toBe(false);
    expect(result.checked).toBe(true);
  });

  it('ignores HIBP padding rows (zero-count entries)', async () => {
    // Even if a padding row accidentally matched our suffix, the
    // zero-count filter keeps us from flagging it.
    const body = '2DC183F740EE76F27B78EB39C8AD972A757:0';
    const fetchImpl = mockFetchReturning(200, body);

    const result = await checkPasswordPwned('P@ssw0rd', { fetchImpl });

    expect(result.pwned).toBe(false);
  });

  it('respects a custom threshold (count below threshold ⇒ not pwned)', async () => {
    const body = '2DC183F740EE76F27B78EB39C8AD972A757:5';
    const fetchImpl = mockFetchReturning(200, body);

    const result = await checkPasswordPwned('P@ssw0rd', {
      fetchImpl,
      threshold: 100,
    });

    expect(result.pwned).toBe(false);
    expect(result.checked).toBe(true);
  });
});

describe('checkPasswordPwned — fail-open', () => {
  it('returns checked=false + pwned=false when the HTTP call throws', async () => {
    const fetchImpl = mockFetchThrowing(new Error('ECONNRESET'));

    const result = await checkPasswordPwned('anything', { fetchImpl });

    expect(result).toEqual({ pwned: false, count: 0, checked: false });
  });

  it('returns fail-open on non-2xx status', async () => {
    const fetchImpl = mockFetchReturning(503, '');

    const result = await checkPasswordPwned('anything', { fetchImpl });

    expect(result.pwned).toBe(false);
    expect(result.checked).toBe(false);
  });

  it('aborts after the configured timeout and fails open', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    const result = await checkPasswordPwned('anything', {
      fetchImpl,
      timeoutMs: 10,
    });

    expect(result).toEqual({ pwned: false, count: 0, checked: false });
  });
});

describe('assertPasswordNotPwned', () => {
  it('throws PwnedPasswordError when the password is in the corpus', async () => {
    const body = '2DC183F740EE76F27B78EB39C8AD972A757:9999';
    const fetchImpl = mockFetchReturning(200, body);

    // Swap the global fetch for the scope of this call via the
    // same dependency the module uses.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await expect(assertPasswordNotPwned('P@ssw0rd')).rejects.toBeInstanceOf(
        PwnedPasswordError,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns silently on a clean password', async () => {
    const fetchImpl = mockFetchReturning(200, '');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await expect(assertPasswordNotPwned('something-novel')).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
