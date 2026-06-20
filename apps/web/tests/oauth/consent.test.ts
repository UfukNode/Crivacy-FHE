// @vitest-environment node
/**
 * OAuth consent-decision handler tests.
 *
 * The consent page POSTs here once the user picks approve / reject.
 * Invariants under test:
 *   - Unknown request id → request_not_found.
 *   - Completed request → invalid_request (duplicate submit guard).
 *   - Expired request → request_expired.
 *   - Reject → redirect with error=access_denied, request marked
 *     completed.
 *   - Approve with cached active consent → reuses the row, no insert.
 *   - Approve with no consent → inserts row, fires
 *     oauth.consent.granted webhook via the event dispatcher.
 *   - Any path, when successful, mints an authorization code and
 *     marks the request completed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrivacyDatabase } from '@/lib/db/client';
import type { OauthAuthorizationRequest } from '@/lib/db/schema/oauth-authorization-requests';
import type { OauthClient } from '@/lib/db/schema/oauth-clients';
import type { OauthConsent } from '@/lib/db/schema/oauth-consents';
import {
  canonicaliseScope,
  hashScope,
  parseScope,
} from '@/lib/oauth';
import { OauthError } from '@/lib/oauth/errors';
import { handleOauthConsentDecision } from '@/server/handlers/oauth-consent';
import * as oauthLib from '@/lib/oauth';
import * as repos from '@/server/repositories';

vi.mock('@/server/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof repos>();
  return {
    ...actual,
    findAuthorizationRequest: vi.fn(),
    markAuthorizationRequestCompleted: vi.fn(),
    attachUserToAuthorizationRequest: vi.fn(),
    findActiveConsent: vi.fn(),
    insertConsent: vi.fn(),
    insertAuthorizationCode: vi.fn(),
  };
});

vi.mock('@/lib/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof oauthLib>();
  return {
    ...actual,
    dispatchOauthConsentEvent: vi.fn(),
  };
});

vi.mock('@/lib/audit/writer', () => ({
  writeAudit: vi.fn(async () => undefined),
  writeAuditBatch: vi.fn(async () => undefined),
}));

// The consent handler now runs a defence-in-depth KYC gate that looks
// up the customer's active credential via `oauth-shared`. These tests
// assume a Basic-level credential so the gate passes; the gate itself
// has dedicated coverage elsewhere. Keeping the mock at module level
// means every `describe` block below starts with the same passing
// baseline unless the test overrides `mockFindCredential`.
// Only stub the credential lookup. `ensureAuthRequestOwnership` is
// real code — it delegates to the repository functions we already
// mock above, so letting it run end-to-end keeps the test honest
// about the attach-then-check contract.
import * as oauthShared from '@/server/handlers/oauth-shared';
vi.mock('@/server/handlers/oauth-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof oauthShared>();
  return {
    ...actual,
    findActiveCredentialForUser: vi.fn(),
  };
});
const mockFindCredential = vi.mocked(oauthShared.findActiveCredentialForUser);

const mockFindAuthRequest = vi.mocked(repos.findAuthorizationRequest);
const mockMarkCompleted = vi.mocked(repos.markAuthorizationRequestCompleted);
const mockAttachUser = vi.mocked(repos.attachUserToAuthorizationRequest);
const mockFindActiveConsent = vi.mocked(repos.findActiveConsent);
const mockInsertConsent = vi.mocked(repos.insertConsent);
const mockInsertAuthCode = vi.mocked(repos.insertAuthorizationCode);
const mockDispatchEvent = vi.mocked(oauthLib.dispatchOauthConsentEvent);

const FIXTURE_NOW = new Date('2026-04-17T12:00:00.000Z');
const USER_ID = 'd1111111-1111-4111-8111-111111111111';
const REQUEST_ID = 'req-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REDIRECT_URI = 'https://firm.example.com/oauth/callback';

const FIXTURE_CLIENT: OauthClient = {
  id: 'c1111111-1111-4111-8111-111111111111',
  firmId: 'f1111111-1111-4111-8111-111111111111',
  clientId: 'crv_oauth_live_fixture_client_id_abcd',
  clientSecretHash: null,
  name: 'Fixture Client',
  description: null,
  logoUrl: null,
  homepageUrl: null,
  redirectUris: [REDIRECT_URI],
  allowedScopes: ['openid', 'kyc'],
  isPublicClient: false,
  consentTtlDays: 90,
  metadata: {},
  createdByFirmUserId: null,
  failedSecretAttempts: 0,
  secretLockedUntil: null,
  revokedAt: null,
  createdAt: FIXTURE_NOW,
  updatedAt: FIXTURE_NOW,
};

function buildAuthRequest(overrides: Partial<OauthAuthorizationRequest> = {}): OauthAuthorizationRequest {
  return {
    id: 'auth-req-uuid-1111',
    requestId: REQUEST_ID,
    clientId: FIXTURE_CLIENT.id,
    userId: null,
    redirectUri: REDIRECT_URI,
    scope: 'openid kyc',
    state: 'csrf-token-xyz',
    nonce: null,
    codeChallenge: null,
    codeChallengeMethod: null,
    uiLocales: null,
    ip: '203.0.113.5',
    userAgent: 'test/1.0',
    completedAt: null,
    expiresAt: new Date(FIXTURE_NOW.getTime() + 900 * 1000),
    createdAt: FIXTURE_NOW,
    ...overrides,
  } as OauthAuthorizationRequest;
}

function buildConsent(overrides: Partial<OauthConsent> = {}): OauthConsent {
  const scopes = parseScope('openid kyc');
  return {
    id: 'con11111-1111-4111-8111-111111111111',
    userId: USER_ID,
    clientId: FIXTURE_CLIENT.id,
    scope: canonicaliseScope(scopes),
    scopeHash: hashScope(scopes),
    grantedAt: FIXTURE_NOW,
    expiresAt: new Date(FIXTURE_NOW.getTime() + 90 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    revokedReason: null,
    lastUsedAt: null,
    ...overrides,
  };
}

// The handler loads the client row via a local helper that runs a
// plain Drizzle select against `oauthClients`. We stub the DB shape
// the helper expects instead of mocking the helper itself — keeps
// the test coupled to observable behaviour, not implementation.
function buildDb(clientRow: OauthClient | null) {
  // The handler now runs the approve-path mutations inside
  // `deps.db.transaction(async (tx) => …)`. The repo functions are
  // `vi.mock`ed above so the callback's `tx` parameter is never used
  // for real queries — we just need `transaction` to exist and to
  // await the callback so the mocked writes fire.
  const builder: Record<string, unknown> = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (clientRow !== null ? [clientRow] : []),
        }),
      }),
    }),
    transaction: async <T>(cb: (tx: CrivacyDatabase) => Promise<T>): Promise<T> => {
      return cb(builder as unknown as CrivacyDatabase);
    },
  };
  return builder as unknown as CrivacyDatabase;
}

const baseDeps = {
  db: buildDb(FIXTURE_CLIENT),
  now: FIXTURE_NOW,
  ip: '203.0.113.5',
  customerLabel: 'test@example.com',
  userAgent: 'test/1.0',
  requestAuditId: 'ecb7b22d-2cc3-4444-8abc-010101010101',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertConsent.mockImplementation(async (_db, input) => ({
    id: 'e1111111-1111-4111-8111-111111111111',
    userId: input.userId,
    clientId: input.clientId,
    scope: input.scope,
    scopeHash: input.scopeHash,
    grantedAt: input.grantedAt,
    expiresAt: input.expiresAt,
    revokedAt: null,
    revokedReason: null,
    lastUsedAt: null,
  }));
  mockInsertAuthCode.mockResolvedValue(undefined);
  // Default: this caller wins the atomic claim. Race-loss tests
  // override this to `false`.
  mockMarkCompleted.mockResolvedValue(true);
  // Default: TOFU attach succeeds for the anonymous-authorize path
  // (`authRequest.userId === null`). Ownership-mismatch tests override
  // the row fixture or this return value.
  mockAttachUser.mockResolvedValue(true);
  mockDispatchEvent.mockResolvedValue(undefined);
  // Default: the user already has a Basic-level credential, so the
  // KYC gate waves them through on `openid kyc` scopes. Tests that
  // need a missing or lower-level credential override this.
  mockFindCredential.mockResolvedValue({
    id: 'cred-uuid-fixture',
    firmId: 'firm-uuid-fixture',
    userRef: USER_ID,
    contractId: null,
    level: 'basic',
    status: 'active',
    identityVerified: true,
    livenessVerified: true,
    addressVerified: false,
    humanScore: 90,
    proofHash: 'sha256:fixture',
    validator: 'didit',
    network: 'sepolia',
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validUntil: new Date('2030-01-01T00:00:00.000Z'),
    confirmedAt: null,
    revokedAt: null,
    revokedReason: null,
    expiredAt: null,
    disclosureBlob: null,
    operatorParty: 'Crivacy::operator',
    userParty: 'User::test',
    templateId: 'crivacy-kyc:Crivacy.KYCCredential:KYCCredential',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleOauthConsentDecision — guards', () => {
  it('throws request_not_found when the authorize request is unknown', async () => {
    mockFindAuthRequest.mockResolvedValue(null);
    await expect(
      handleOauthConsentDecision(baseDeps, {
        requestId: REQUEST_ID,
        userId: USER_ID,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({
      name: 'OauthError',
      code: 'request_not_found',
    });
  });

  it('throws invalid_request when the request has already been completed', async () => {
    mockFindAuthRequest.mockResolvedValue(
      buildAuthRequest({ completedAt: new Date(FIXTURE_NOW.getTime() - 1000) }),
    );
    await expect(
      handleOauthConsentDecision(baseDeps, {
        requestId: REQUEST_ID,
        userId: USER_ID,
        decision: 'approve',
      }),
    ).rejects.toBeInstanceOf(OauthError);
  });

  it('throws request_expired when the request is past its TTL', async () => {
    mockFindAuthRequest.mockResolvedValue(
      buildAuthRequest({ expiresAt: new Date(FIXTURE_NOW.getTime() - 1) }),
    );
    await expect(
      handleOauthConsentDecision(baseDeps, {
        requestId: REQUEST_ID,
        userId: USER_ID,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'request_expired' });
  });
});

describe('handleOauthConsentDecision — reject path', () => {
  it('returns a redirect URL with error=access_denied and echoes state', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest());
    const result = await handleOauthConsentDecision(baseDeps, {
      requestId: REQUEST_ID,
      userId: USER_ID,
      decision: 'reject',
    });
    const url = new URL(result.redirectUrl);
    expect(url.origin + url.pathname).toBe(REDIRECT_URI);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('csrf-token-xyz');
    expect(mockMarkCompleted).toHaveBeenCalledWith(baseDeps.db, REQUEST_ID, FIXTURE_NOW);
    expect(mockInsertAuthCode).not.toHaveBeenCalled();
    expect(mockInsertConsent).not.toHaveBeenCalled();
    expect(mockDispatchEvent).not.toHaveBeenCalled();
  });
});

describe('handleOauthConsentDecision — approve path', () => {
  it('reuses an active consent row and mints a code without calling insertConsent', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest());
    mockFindActiveConsent.mockResolvedValue(buildConsent());

    const result = await handleOauthConsentDecision(baseDeps, {
      requestId: REQUEST_ID,
      userId: USER_ID,
      decision: 'approve',
    });
    const url = new URL(result.redirectUrl);
    expect(url.searchParams.get('code')?.length).toBeGreaterThan(20);
    expect(url.searchParams.get('state')).toBe('csrf-token-xyz');

    expect(mockInsertAuthCode).toHaveBeenCalledTimes(1);
    expect(mockInsertConsent).not.toHaveBeenCalled();
    expect(mockMarkCompleted).toHaveBeenCalledTimes(1);
    // No new consent → no webhook fan-out.
    expect(mockDispatchEvent).not.toHaveBeenCalled();
  });

  it('creates a new consent row and fires oauth.consent.granted when no cached consent exists', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest());
    mockFindActiveConsent.mockResolvedValue(null);

    const result = await handleOauthConsentDecision(baseDeps, {
      requestId: REQUEST_ID,
      userId: USER_ID,
      decision: 'approve',
    });
    expect(result.redirectUrl).toContain('code=');
    expect(mockInsertConsent).toHaveBeenCalledTimes(1);
    expect(mockInsertAuthCode).toHaveBeenCalledTimes(1);
    expect(mockMarkCompleted).toHaveBeenCalledTimes(1);
    expect(mockDispatchEvent).toHaveBeenCalledTimes(1);
    const [, eventType, eventInput] = mockDispatchEvent.mock.calls[0]!;
    expect(eventType).toBe('oauth.consent.granted');
    expect(eventInput.firmId).toBe(FIXTURE_CLIENT.firmId);
    expect(eventInput.clientId).toBe(FIXTURE_CLIENT.clientId);
    expect(eventInput.userId).toBe(USER_ID);
    expect(eventInput.consentId).toBe('e1111111-1111-4111-8111-111111111111');
  });

  it('throws invalid_client when the client record is missing', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest());
    const depsWithNoClient = { ...baseDeps, db: buildDb(null) };
    await expect(
      handleOauthConsentDecision(depsWithNoClient, {
        requestId: REQUEST_ID,
        userId: USER_ID,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'invalid_client' });
    expect(mockInsertAuthCode).not.toHaveBeenCalled();
  });

  it('passes through code_challenge metadata onto the inserted code row', async () => {
    mockFindAuthRequest.mockResolvedValue(
      buildAuthRequest({
        codeChallenge: 'A'.repeat(43),
        codeChallengeMethod: 'S256',
        nonce: 'n-42',
      }),
    );
    mockFindActiveConsent.mockResolvedValue(null);

    await handleOauthConsentDecision(baseDeps, {
      requestId: REQUEST_ID,
      userId: USER_ID,
      decision: 'approve',
    });
    expect(mockInsertAuthCode).toHaveBeenCalledTimes(1);
    const [, insertedCode] = mockInsertAuthCode.mock.calls[0]!;
    expect(insertedCode.codeChallenge).toBe('A'.repeat(43));
    expect(insertedCode.codeChallengeMethod).toBe('S256');
    expect(insertedCode.nonce).toBe('n-42');
    expect(insertedCode.redirectUri).toBe(REDIRECT_URI);
    expect(insertedCode.ipBoundTo).toBe('203.0.113.5');
  });
});

describe('handleOauthConsentDecision — ownership gate', () => {
  // A consent submit is the mutation boundary — if the authorize
  // request was minted for customer A and the call arrives on
  // customer B's session, no code may be issued. These tests pin
  // that contract so a future refactor that drops the gate breaks
  // loudly.

  const OTHER_USER_ID = 'd2222222-2222-4222-8222-222222222222';

  it('rejects approve when the authorize request belongs to a different user', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest({ userId: OTHER_USER_ID }));

    await expect(
      handleOauthConsentDecision(baseDeps, {
        requestId: REQUEST_ID,
        userId: USER_ID,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({
      name: 'OauthError',
      code: 'access_denied',
    });
    expect(mockAttachUser).not.toHaveBeenCalled();
    expect(mockInsertAuthCode).not.toHaveBeenCalled();
    expect(mockInsertConsent).not.toHaveBeenCalled();
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('rejects reject when the authorize request belongs to a different user', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest({ userId: OTHER_USER_ID }));

    await expect(
      handleOauthConsentDecision(baseDeps, {
        requestId: REQUEST_ID,
        userId: USER_ID,
        decision: 'reject',
      }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });

  it('TOFU-attaches the caller when the authorize request has no owner yet', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest({ userId: null }));
    mockFindActiveConsent.mockResolvedValue(null);

    const result = await handleOauthConsentDecision(baseDeps, {
      requestId: REQUEST_ID,
      userId: USER_ID,
      decision: 'approve',
    });
    expect(result.redirectUrl).toContain('code=');
    expect(mockAttachUser).toHaveBeenCalledTimes(1);
    const [, attachReq, attachUser] = mockAttachUser.mock.calls[0]!;
    expect(attachReq).toBe(REQUEST_ID);
    expect(attachUser).toBe(USER_ID);
  });

  it('allows the owner through without re-attaching when userId already matches', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest({ userId: USER_ID }));
    mockFindActiveConsent.mockResolvedValue(null);

    const result = await handleOauthConsentDecision(baseDeps, {
      requestId: REQUEST_ID,
      userId: USER_ID,
      decision: 'approve',
    });
    expect(result.redirectUrl).toContain('code=');
    // No attach call — the request was already bound to this user at
    // authorize time (cookie-carrying caller).
    expect(mockAttachUser).not.toHaveBeenCalled();
  });

  it('rejects approve when TOFU attach loses the race and the winner is a different user', async () => {
    mockFindAuthRequest
      .mockResolvedValueOnce(buildAuthRequest({ userId: null }))
      // Second read (the helper's re-verify after a failed attach)
      // finds a different customer already bound to the row.
      .mockResolvedValueOnce(buildAuthRequest({ userId: OTHER_USER_ID }));
    mockAttachUser.mockResolvedValue(false);

    await expect(
      handleOauthConsentDecision(baseDeps, {
        requestId: REQUEST_ID,
        userId: USER_ID,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    expect(mockInsertAuthCode).not.toHaveBeenCalled();
    expect(mockMarkCompleted).not.toHaveBeenCalled();
  });
});

describe('handleOauthConsentDecision — atomic claim (race defence)', () => {
  // Two parallel POSTs with the same `request_id` used to both observe
  // `completed_at === null`, both mint a code, and both mark the
  // request completed at the end — a silent duplicate-mint. The
  // atomic UPDATE … WHERE completed_at IS NULL RETURNING in
  // `markAuthorizationRequestCompleted` lets exactly one caller flip
  // the flag; the loser gets `false` and we short-circuit with
  // `invalid_request`. These tests pin that contract.

  it('rejects the approve path with invalid_request when the claim is lost', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest());
    mockFindActiveConsent.mockResolvedValue(null);
    // Simulate the concurrent winner already flipped completed_at.
    mockMarkCompleted.mockResolvedValue(false);

    await expect(
      handleOauthConsentDecision(baseDeps, {
        requestId: REQUEST_ID,
        userId: USER_ID,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({
      name: 'OauthError',
      code: 'invalid_request',
    });

    // No consent row, no code, no webhook — TX must have rolled back.
    expect(mockInsertConsent).not.toHaveBeenCalled();
    expect(mockInsertAuthCode).not.toHaveBeenCalled();
    expect(mockDispatchEvent).not.toHaveBeenCalled();
  });

  it('rejects the reject path with invalid_request when the claim is lost', async () => {
    mockFindAuthRequest.mockResolvedValue(buildAuthRequest());
    mockMarkCompleted.mockResolvedValue(false);

    await expect(
      handleOauthConsentDecision(baseDeps, {
        requestId: REQUEST_ID,
        userId: USER_ID,
        decision: 'reject',
      }),
    ).rejects.toMatchObject({
      name: 'OauthError',
      code: 'invalid_request',
    });
    expect(mockInsertAuthCode).not.toHaveBeenCalled();
  });
});
