// @vitest-environment node
/**
 * destructive-reauth — unit coverage for the password+TOTP step-up
 * primitive that sits in front of all 24 destructive endpoints
 * (16 admin sweep + 6 firm legacy + 1 admin pilot + 1 webhook PATCH).
 *
 * The helper composes two leaf primitives:
 *   - `reauthGate` (validated separately in reauth.test.ts) — runs
 *     the actual password + factor verification.
 *   - `parseBody` (validated separately in middleware tests) — pulls
 *     the envelope shape off the request body.
 *
 * This suite mocks both at their module boundary and exercises the
 * shape-mapping layer: which `reauthGate` outcome maps to which
 * discriminated-union return shape, and how `parseDestructiveEnvelope`
 * splits the envelope from the rest of the body for downstream
 * Zod validation.
 *
 * The 24 endpoint route files all call this helper identically; if
 * the helper's contract holds, every endpoint inherits the same
 * step-up guarantees. Per-endpoint integration tests live in the
 * `apps/web/.race-test/` smoke matrix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/reauth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/reauth')>(
    '@/lib/auth/reauth',
  );
  return {
    ...actual,
    reauthGate: vi.fn(),
  };
});
vi.mock('@/server/middleware/parse', () => ({
  parseBody: vi.fn(),
}));

import type { AuthConfig } from '@/lib/auth/config';
import type { CrivacyDatabase } from '@/lib/db/client';
import { reauthGate } from '@/lib/auth/reauth';
import { parseBody } from '@/server/middleware/parse';
import {
  parseDestructiveEnvelope,
  ReauthEnvelopeSchema,
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';

const NOW = new Date('2026-04-27T00:00:00Z');
const AUTH_CONFIG = {} as AuthConfig;
const DB = {} as CrivacyDatabase;
const SUBJECT_ID = 'subject-uuid-xxx';

const VALID_ENVELOPE = {
  currentPassword: 'StrongPass123!',
  totpCode: '123456',
} as const;

describe('auth/destructive-reauth — schema', () => {
  it('exposes a Zod schema with currentPassword + totpCode required', () => {
    expect(ReauthEnvelopeSchema.parse(VALID_ENVELOPE)).toEqual(VALID_ENVELOPE);
  });

  it('rejects a body that drops totpCode (Zod required)', () => {
    expect(() =>
      ReauthEnvelopeSchema.parse({ currentPassword: 'X' }),
    ).toThrow();
  });

  it('rejects a body that drops currentPassword (Zod required)', () => {
    expect(() => ReauthEnvelopeSchema.parse({ totpCode: '123456' })).toThrow();
  });

  it('rejects a totpCode that is not 6 digits', () => {
    expect(() =>
      ReauthEnvelopeSchema.parse({
        currentPassword: 'StrongPass123!',
        totpCode: '12345', // 5 digits
      }),
    ).toThrow();
    expect(() =>
      ReauthEnvelopeSchema.parse({
        currentPassword: 'StrongPass123!',
        totpCode: 'abcdef', // non-numeric
      }),
    ).toThrow();
  });

  it('exports a shape object that callers can spread into other Zod objects', () => {
    expect(reauthEnvelopeShape).toHaveProperty('currentPassword');
    expect(reauthEnvelopeShape).toHaveProperty('totpCode');
  });
});

describe('auth/destructive-reauth — requireTotpReauth', () => {
  beforeEach(() => {
    vi.mocked(reauthGate).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok with verifiedPasswordHash on success', async () => {
    vi.mocked(reauthGate).mockResolvedValue({
      status: 'ok',
      verifiedPasswordHash: 'argon2-hash-xxx',
    });

    const result = await requireTotpReauth({
      db: DB,
      subject: { kind: 'admin', id: SUBJECT_ID },
      envelope: VALID_ENVELOPE,
      now: NOW,
      authConfig: AUTH_CONFIG,
    });

    expect(result).toEqual({
      status: 'ok',
      verifiedPasswordHash: 'argon2-hash-xxx',
    });
    expect(reauthGate).toHaveBeenCalledWith({
      db: DB,
      subject: { kind: 'admin', id: SUBJECT_ID },
      password: 'StrongPass123!',
      factor: { type: 'totp', code: '123456' },
      now: NOW,
      authConfig: AUTH_CONFIG,
    });
  });

  it('passes through the firm subject kind unchanged', async () => {
    vi.mocked(reauthGate).mockResolvedValue({
      status: 'ok',
      verifiedPasswordHash: 'firm-hash',
    });

    await requireTotpReauth({
      db: DB,
      subject: { kind: 'firm', id: SUBJECT_ID },
      envelope: VALID_ENVELOPE,
      now: NOW,
      authConfig: AUTH_CONFIG,
    });

    expect(reauthGate).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: { kind: 'firm', id: SUBJECT_ID },
      }),
    );
  });

  it('maps wrong_password to denied + 401 unauthenticated', async () => {
    vi.mocked(reauthGate).mockResolvedValue({
      status: 'failed',
      reason: 'wrong_password',
    });

    const result = await requireTotpReauth({
      db: DB,
      subject: { kind: 'admin', id: SUBJECT_ID },
      envelope: VALID_ENVELOPE,
      now: NOW,
      authConfig: AUTH_CONFIG,
    });

    expect(result.status).toBe('denied');
    if (result.status !== 'denied') return; // type narrow
    expect(result.httpStatus).toBe(401);
    expect(result.code).toBe('unauthenticated');
  });

  it('maps totp_invalid to denied + 401 totp_invalid', async () => {
    vi.mocked(reauthGate).mockResolvedValue({
      status: 'failed',
      reason: 'totp_invalid',
    });

    const result = await requireTotpReauth({
      db: DB,
      subject: { kind: 'admin', id: SUBJECT_ID },
      envelope: VALID_ENVELOPE,
      now: NOW,
      authConfig: AUTH_CONFIG,
    });

    expect(result.status).toBe('denied');
    if (result.status !== 'denied') return;
    expect(result.httpStatus).toBe(401);
    expect(result.code).toBe('totp_invalid');
  });

  it('maps totp_not_enrolled to denied + 401 totp_required', async () => {
    vi.mocked(reauthGate).mockResolvedValue({
      status: 'failed',
      reason: 'totp_not_enrolled',
    });

    const result = await requireTotpReauth({
      db: DB,
      subject: { kind: 'admin', id: SUBJECT_ID },
      envelope: VALID_ENVELOPE,
      now: NOW,
      authConfig: AUTH_CONFIG,
    });

    expect(result.status).toBe('denied');
    if (result.status !== 'denied') return;
    expect(result.code).toBe('totp_required');
  });

  it('maps factor_not_supported to denied with 400 (defensive — customer subject would surface here)', async () => {
    vi.mocked(reauthGate).mockResolvedValue({
      status: 'failed',
      reason: 'factor_not_supported',
    });

    const result = await requireTotpReauth({
      db: DB,
      subject: { kind: 'admin', id: SUBJECT_ID },
      envelope: VALID_ENVELOPE,
      now: NOW,
      authConfig: AUTH_CONFIG,
    });

    expect(result.status).toBe('denied');
    if (result.status !== 'denied') return;
    expect(result.httpStatus).toBe(400);
    expect(result.code).toBe('validation_failed');
  });

  it('maps password_not_set to denied + 409 conflict', async () => {
    vi.mocked(reauthGate).mockResolvedValue({
      status: 'failed',
      reason: 'password_not_set',
    });

    const result = await requireTotpReauth({
      db: DB,
      subject: { kind: 'admin', id: SUBJECT_ID },
      envelope: VALID_ENVELOPE,
      now: NOW,
      authConfig: AUTH_CONFIG,
    });

    expect(result.status).toBe('denied');
    if (result.status !== 'denied') return;
    expect(result.httpStatus).toBe(409);
    expect(result.code).toBe('conflict');
  });
});

describe('auth/destructive-reauth — parseDestructiveEnvelope', () => {
  beforeEach(() => {
    vi.mocked(parseBody).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeRequest(): Request {
    // The helper passes the request straight to the mocked parseBody;
    // any object that satisfies the type signature is fine.
    return new Request('https://x.test/x', { method: 'POST' });
  }

  it('splits the envelope from the rest of the body', async () => {
    vi.mocked(parseBody).mockResolvedValue({
      currentPassword: 'P',
      totpCode: '111111',
      name: 'New role',
      tier: 'pro',
    } as Record<string, unknown>);

    const result = await parseDestructiveEnvelope(
      fakeRequest() as unknown as Parameters<typeof parseDestructiveEnvelope>[0],
    );

    expect(result.gate).toEqual({
      currentPassword: 'P',
      totpCode: '111111',
    });
    expect(result.rest).toEqual({ name: 'New role', tier: 'pro' });
  });

  it('returns an empty rest when only the envelope was sent', async () => {
    vi.mocked(parseBody).mockResolvedValue({
      currentPassword: 'P',
      totpCode: '222222',
    } as Record<string, unknown>);

    const result = await parseDestructiveEnvelope(
      fakeRequest() as unknown as Parameters<typeof parseDestructiveEnvelope>[0],
    );

    expect(result.gate).toEqual({
      currentPassword: 'P',
      totpCode: '222222',
    });
    expect(result.rest).toEqual({});
  });
});
