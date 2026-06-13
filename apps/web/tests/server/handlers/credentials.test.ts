/**
 * Tests for credential handlers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleGetCredential,
  handleGetCredentialHistory,
  handleVerifyCredential,
} from '@/server/handlers';
import * as repos from '@/server/repositories';

import { FIXTURE_FIRM_ID, FIXTURE_NOW, buildAuthCtx } from './helpers';

vi.mock('@/server/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof repos>();
  return {
    ...actual,
    findCredentialByUserRef: vi.fn(),
    listCredentialHistory: vi.fn(),
  };
});

// The verify handler reads the credential straight from the CrivacyKYC contract.
// `vi.hoisted` guarantees the spy exists when the hoisted `vi.mock` factory runs.
const { fheFetchCredentialSpy } = vi.hoisted(() => ({
  fheFetchCredentialSpy: vi.fn(async () => ({
    status: 'active' as const,
    isActive: true,
    handles: {
      level: '0x01',
      humanScore: '0x02',
      identityVerified: '0x03',
      livenessVerified: '0x04',
      addressVerified: '0x05',
      sanctioned: '0x06',
      eligible: '0x07',
    },
  })),
}));
vi.mock('@crivacy-fhe/credential', () => ({
  getFheClient: vi.fn(() => ({ fetchCredential: fheFetchCredentialSpy })),
}));
vi.mock('@/lib/audit/writer', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

const mockFindCred = vi.mocked(repos.findCredentialByUserRef);
const mockListHistory = vi.mocked(repos.listCredentialHistory);

function buildCredRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-1111',
    firmId: FIXTURE_FIRM_ID,
    userRef: 'user@example.com',
    chainContractId: 'chain-contract-id-001',
    chainTemplateId: 'template-id',
    chainNetwork: 'sepolia',
    operatorParty: '0x78c1000000000000000000000000000000000000',
    userParty: '0x1111111111111111111111111111111111111111',
    proofHash: 'abcdef1234567890',
    status: 'active',
    level: 'basic',
    validFrom: FIXTURE_NOW,
    validUntil: new Date(FIXTURE_NOW.getTime() + 365 * 24 * 60 * 60 * 1000),
    validator: 'didit',
    humanScore: 95,
    identityVerified: 1,
    livenessVerified: 1,
    addressVerified: 0,
    disclosureBlobCache: null,
    revokedAt: null,
    revokedReason: null,
    expiredAt: null,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleGetCredential', () => {
  it('returns active credential with 200', async () => {
    const cred = buildCredRow();
    mockFindCred.mockResolvedValue(cred as never);

    const ctx = buildAuthCtx({
      url: 'https://api.crivacy.test/api/v1/credentials/user@example.com',
    });

    const params = Promise.resolve({ userRef: 'user@example.com' } as Record<
      string,
      string | string[]
    >);
    const res = await handleGetCredential(ctx, params);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.contractId).toBe('chain-contract-id-001');
    expect(body.status).toBe('active');
    expect(body.validator).toBe('DiditValidator');
  });

  it('returns 404 when no credential exists', async () => {
    mockFindCred.mockResolvedValue(null);

    const ctx = buildAuthCtx({
      url: 'https://api.crivacy.test/api/v1/credentials/unknown',
    });

    const params = Promise.resolve({ userRef: 'unknown' } as Record<string, string | string[]>);
    const res = await handleGetCredential(ctx, params);
    expect(res.status).toBe(404);
  });

  it('returns 410 when credential is revoked', async () => {
    const cred = buildCredRow({ status: 'revoked', revokedAt: FIXTURE_NOW });
    mockFindCred.mockResolvedValue(cred as never);

    const ctx = buildAuthCtx({
      url: 'https://api.crivacy.test/api/v1/credentials/user@example.com',
    });

    const params = Promise.resolve({ userRef: 'user@example.com' } as Record<
      string,
      string | string[]
    >);
    const res = await handleGetCredential(ctx, params);
    expect(res.status).toBe(410);

    const body = await res.json();
    expect(body.error.code).toBe('credential_revoked');
  });

  it('returns 410 when credential is expired', async () => {
    const cred = buildCredRow({ status: 'expired', expiredAt: FIXTURE_NOW });
    mockFindCred.mockResolvedValue(cred as never);

    const ctx = buildAuthCtx({
      url: 'https://api.crivacy.test/api/v1/credentials/user@example.com',
    });

    const params = Promise.resolve({ userRef: 'user@example.com' } as Record<
      string,
      string | string[]
    >);
    const res = await handleGetCredential(ctx, params);
    expect(res.status).toBe(410);

    const body = await res.json();
    expect(body.error.code).toBe('credential_expired');
  });

  it('maps validator types correctly', async () => {
    const tests: [string, string][] = [
      ['didit', 'DiditValidator'],
      ['chain', 'ChainValidator'],
      ['zk', 'ZKValidator'],
      ['custom', 'custom'],
    ];

    for (const [dbVal, apiVal] of tests) {
      const cred = buildCredRow({ validator: dbVal });
      mockFindCred.mockResolvedValue(cred as never);

      const ctx = buildAuthCtx();
      const params = Promise.resolve({ userRef: 'user@example.com' } as Record<
        string,
        string | string[]
      >);
      const res = await handleGetCredential(ctx, params);
      const body = await res.json();
      expect(body.validator).toBe(apiVal);
    }
  });
});

describe('handleVerifyCredential', () => {
  it('returns verification result', async () => {
    mockFindCred.mockResolvedValue(
      buildCredRow({ id: '11111111-1111-4111-8111-111111111111' }) as never,
    );
    const ctx = buildAuthCtx({
      method: 'POST',
      body: JSON.stringify({
        userAddress: '0x1234567890abcdef1234567890abcdef12345678',
        expectedUserRef: 'user@example.com',
      }),
    });

    const res = await handleVerifyCredential(ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('valid');
    expect(body).toHaveProperty('verifiedAt');
    expect(body.valid).toBe(true);
    expect(fheFetchCredentialSpy).toHaveBeenCalled();
  });
});

describe('handleGetCredentialHistory', () => {
  it('returns history entries', async () => {
    const creds = [
      buildCredRow(),
      buildCredRow({
        id: 'cred-2222',
        status: 'revoked',
        revokedAt: FIXTURE_NOW,
        revokedReason: 'test',
      }),
    ];
    mockListHistory.mockResolvedValue(creds as never);

    const ctx = buildAuthCtx({
      url: 'https://api.crivacy.test/api/v1/credentials/user@example.com/history',
    });

    const params = Promise.resolve({ userRef: 'user@example.com' } as Record<
      string,
      string | string[]
    >);
    const res = await handleGetCredentialHistory(ctx, params);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.userRef).toBe('user@example.com');
    expect(body.entries).toBeInstanceOf(Array);
    expect(body.entries.length).toBe(2);
    expect(body.total).toBe(2);
  });

  it('returns empty history for unknown user', async () => {
    mockListHistory.mockResolvedValue([]);

    const ctx = buildAuthCtx();
    const params = Promise.resolve({ userRef: 'nobody' } as Record<string, string | string[]>);
    const res = await handleGetCredentialHistory(ctx, params);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.entries).toEqual([]);
    expect(body.total).toBe(0);
  });
});
