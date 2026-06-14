// @vitest-environment node
/**
 * Credential pipeline worker — replay / double-mint guard tests.
 *
 * pg-boss's `singletonKey` only dedups jobs that are still in
 * `created`/`active`/`retry` state. Once a job reaches `completed`,
 * a redelivered Didit webhook (manual replay, after-TTL resend)
 * enqueues a fresh job with the same key and the worker re-enters
 * `processCredentialPipeline`. Without a guard the identity phase
 * would:
 *
 *   1. Call Chain `createCredential` again — second on-chain
 *      contract for the same customer.
 *   2. Fail at the `kyc_credentials_meta_firm_user_active_key`
 *      partial unique index on the final INSERT, leaving the
 *      orphan Chain contract un-archived.
 *
 * The worker now short-circuits as soon as it finds a
 * `pending`/`active` credential row for the customer under the
 * self-service firm. These tests pin that contract so a future
 * refactor that drops the guard breaks loudly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Module mocks -----------------------------------------------------------
//
// The worker reaches into Didit, Chain, and the audit writer through
// bare module imports (no DI for those). To keep the guard path
// deterministic we stub the minimum surface each of those touches.

vi.mock('@crivacy-fhe/adapter-didit/config', () => ({
  getDiditConfig: vi.fn(() => ({
    webhookSecret: 'fixture-secret',
    webhookDriftSeconds: 300,
    apiBaseUrl: 'https://didit.test',
    apiKey: 'fixture-api-key',
  })),
}));

vi.mock('@crivacy-fhe/adapter-didit/session', () => ({
  getDecision: vi.fn(async () => ({
    session_id: 'didit-session-abc',
    status: 'Approved',
    workflow_type: 'identity',
    decision: {},
  })),
}));

vi.mock('@crivacy-fhe/adapter-didit/mapping', () => ({
  reduceDecision: vi.fn(() => ({
    outcome: 'passed',
    identityVerified: true,
    livenessVerified: true,
    addressVerified: false,
    humanScore: 87,
    reasons: [],
  })),
  computeProofHash: vi.fn(() => 'abcdef0123456789'),
}));

// `extract-identity` mock removed in PII purge (migration
// 20260509000000) — the worker no longer imports those extractors;
// PII never enters Crivacy memory or DB.

vi.mock('@/lib/proof-schemas', () => ({
  // Worker boot calls seedProofSchemas before accepting jobs;
  // resolveProofSchemaId is hit per mint to attach the FK.
  // Tests never exercise drift detection (covered by the dedicated
  // proof-schema.test.ts), so simple no-op stubs suffice here.
  seedProofSchemas: vi.fn(async () => undefined),
  resolveProofSchemaId: vi.fn(async () => 'fixture-proof-schema-uuid'),
}));

vi.mock('@crivacy-fhe/adapter-didit/types', () => ({
  asDiditSessionIdUnchecked: vi.fn((s: string) => s),
}));

// The on-chain mint spy is the critical assertion target — the guard
// MUST short-circuit before this gets called on a replay. The B2B
// branch shares the same spy so the second test suite can assert the
// mint DID happen end-to-end.
const TX_HASH = '0xabc0000000000000000000000000000000000000000000000000000000000001';
const CUSTOMER_ADDRESS = '0x1111111111111111111111111111111111111111';
const B2B_ADDRESS = '0x2222222222222222222222222222222222222222';
const fheCreateCredentialSpy = vi.fn(async (input: { userAddress: string }) => ({
  txHash: TX_HASH,
  userAddress: input.userAddress,
}));
const fheFetchCredentialSpy = vi.fn(async () => ({
  status: 'active',
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
}));
const fheRevokeCredentialSpy = vi.fn(async () => TX_HASH);

// Mock the FHE on-chain client + the customer-address resolver — the two
// seams the worker reaches into after the Chain → FHE migration.
vi.mock('@crivacy-fhe/credential', () => ({
  getFheClient: vi.fn(() => ({
    config: {
      operatorAddress: '0x78c1000000000000000000000000000000000000',
      networkLabel: 'sepolia',
      kycAddress: '0x91f4000000000000000000000000000000000000',
      nftAddress: '0x27a9000000000000000000000000000000000000',
    },
    createCredential: fheCreateCredentialSpy,
    fetchCredential: fheFetchCredentialSpy,
    revokeCredential: fheRevokeCredentialSpy,
  })),
}));

vi.mock('@/lib/fhe/customer-address', () => ({
  EVM_WALLET_PROVIDER: 'evm_wallet',
  getCustomerWalletAddress: vi.fn(async () => CUSTOMER_ADDRESS),
  requireCustomerWalletAddress: vi.fn(async () => CUSTOMER_ADDRESS),
  deriveB2bUserAddress: vi.fn(() => B2B_ADDRESS),
}));

vi.mock('@/lib/audit/writer', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

vi.mock('@/lib/notification', () => ({
  createNotification: vi.fn(async () => undefined),
}));

// B2B-branch-specific mocks. The customer-flow tests above don't
// reach these because they short-circuit on the replay guard before
// any of these dependencies are imported.
const insertCredentialMetaSpy = vi.fn(async (_db: unknown, input: Record<string, unknown>) => ({
  id: '11111111-1111-4111-8111-111111111111',
  firmId: input['firmId'],
  userRef: input['userRef'],
  chainContractId: input['chainContractId'],
  chainPackageName: input['chainPackageName'],
  chainTemplateId: input['chainTemplateId'],
  chainNetwork: input['chainNetwork'],
  operatorParty: input['operatorParty'],
  userParty: input['userParty'],
  level: input['level'],
  status: 'active',
  validator: input['validator'],
  proofHash: input['proofHash'],
  proofSchemaId: input['proofSchemaId'],
  humanScore: input['humanScore'],
  identityVerified: input['identityVerified'],
  livenessVerified: input['livenessVerified'],
  addressVerified: input['addressVerified'],
  validFrom: new Date('2026-05-08T12:00:00.000Z'),
  validUntil: input['validUntil'],
  confirmedAt: input['confirmedAt'],
  revokedAt: null,
  revokedReason: null,
  expiredAt: null,
  disclosureBlobCache: input['disclosureBlobCache'],
  disclosureBlobFetchedAt: input['disclosureBlobFetchedAt'],
  chainSubmissionId: input['chainSubmissionId'],
  kycSessionId: input['kycSessionId'],
  supersededBy: null,
  nftContractId: null,
  nftMintedAt: null,
  nftBurnedAt: null,
  createdAt: new Date('2026-05-08T12:00:00.000Z'),
  updatedAt: new Date('2026-05-08T12:00:00.000Z'),
}));

vi.mock('@/server/repositories/credentials', () => ({
  createCredential: insertCredentialMetaSpy,
}));

const emitFirmEventSpy = vi.fn(async () => ({ eventId: 'event-uuid', deliveryCount: 1 }));

vi.mock('@/lib/webhook', () => ({
  emitFirmEvent: emitFirmEventSpy,
  emitUserEvent: vi.fn(async () => ({ eventId: 'event-uuid', deliveryCount: 0 })),
}));

// The import comes AFTER the mocks so vi.mock hoisting applies.
import { processCredentialPipeline } from '@/server/jobs/credential-pipeline-worker';

// ---------------------------------------------------------------------------

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    CRIVACY_SELF_SERVICE_FIRM_ID: 'f1111111-1111-4111-8111-111111111111',
  };
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

// ---------------------------------------------------------------------------

/**
 * Build a DB stub whose `select().from().where().limit()` calls
 * replay an ordered queue of result sets. The worker issues its
 * reads in a known sequence (customer lookup, then the guard
 * lookup); the test queues the response for each.
 */
function buildDb(responses: Array<readonly Record<string, unknown>[]>) {
  let idx = 0;
  const builder = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const next = responses[idx] ?? [];
            idx++;
            return next;
          },
        }),
      }),
    }),
  };
  return builder as unknown as Parameters<typeof processCredentialPipeline>[0]['db'];
}

// ---------------------------------------------------------------------------

describe('processCredentialPipeline — replay guard', () => {
  it('skips identity phase mint when an active credential already exists', async () => {
    // Sequence:
    //   #0 select customers      -> one customer row
    //   #1 select kyc_credentials_meta (the guard)
    //                             -> one row, status='active'
    const db = buildDb([
      [
        {
          id: 'customer-uuid',
          status: 'active',
          kycFieldsLocked: false,
          kycLevel: 'kyc_0',
          kycScore: 0,
        },
      ],
      [
        {
          id: 'existing-credential-uuid',
          chainContractId: 'chain-contract-id-abc',
          level: 'basic',
          status: 'active',
        },
      ],
    ]);

    const infoSpy = vi.fn();
    await processCredentialPipeline(
      { db, logger: { info: infoSpy, error: vi.fn() } },
      {
        kycSessionId: 'session-uuid',
        customerId: 'customer-uuid',
        diditSessionId: 'didit-session-abc',
        phase: 'identity',
      },
    );

    // Chain mint was NOT called — this is the assertion that
    // proves the guard worked. Any failure here means a replayed
    // Didit webhook is about to double-mint.
    expect(fheCreateCredentialSpy).not.toHaveBeenCalled();

    // A diagnostic log fires so SOC can tell "we skipped a replay"
    // from "the pipeline never ran". Match on the guard's signature
    // message rather than the full body so future copy tweaks
    // don't break the test.
    const matchingLog = infoSpy.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('Active identity credential already exists'),
    );
    expect(matchingLog).toBeDefined();
  });

  it('skips identity phase when the existing row is still in pending status', async () => {
    // Covers the edge case where a previous mint landed the DB
    // row in `pending` (waiting for Chain confirmation) and a
    // replay comes in before the first attempt completes — still
    // a duplicate, still must short-circuit.
    const db = buildDb([
      [
        {
          id: 'customer-uuid',
          status: 'active',
          kycFieldsLocked: false,
          kycLevel: 'kyc_0',
          kycScore: 0,
        },
      ],
      [
        {
          id: 'existing-credential-uuid',
          chainContractId: null,
          level: 'basic',
          status: 'pending',
        },
      ],
    ]);

    await processCredentialPipeline(
      { db, logger: { info: vi.fn(), error: vi.fn() } },
      {
        kycSessionId: 'session-uuid',
        customerId: 'customer-uuid',
        diditSessionId: 'didit-session-abc',
        phase: 'identity',
      },
    );

    expect(fheCreateCredentialSpy).not.toHaveBeenCalled();
  });

  it('B2B flow: short-circuits when an active credential already exists for (firmId, userRef)', async () => {
    // Mirror of the customer-flow replay guard, but for the B2B
    // branch. Webhook redelivery against an already-minted firm
    // credential must not trigger a second Chain mint.
    const db = buildDb([
      [
        {
          id: 'existing-credential-uuid',
          status: 'active',
          chainContractId: 'chain-contract-id-existing',
        },
      ],
    ]);

    await processCredentialPipeline(
      { db, logger: { info: vi.fn(), error: vi.fn() } },
      {
        flow: 'b2b',
        kycSessionId: '22222222-2222-4222-8222-222222222222',
        firmId: '33333333-3333-4333-8333-333333333333',
        userRef: 'firm-local-user-99',
        diditSessionId: 'didit-session-b2b',
        phase: 'identity',
      },
    );

    expect(fheCreateCredentialSpy).not.toHaveBeenCalled();
    expect(insertCredentialMetaSpy).not.toHaveBeenCalled();
    expect(emitFirmEventSpy).not.toHaveBeenCalled();
  });

  it('B2B flow: mint + emit kyc.session.approved with the canonical credential view (blob inline)', async () => {
    // The full happy path. Sequence:
    //   #0 select kyc_credentials_meta (idempotency guard) → empty
    // After the guard passes, the worker runs Didit fetch → reduce →
    // proof hash → Chain mint → fetch blob → INSERT meta → audit →
    // emit. Each external is stubbed; the assertions pin both the
    // Chain mint shape and the webhook payload's `disclosureBlob`
    // (proves the OAuth↔B2B blob disparity is closed end-to-end).
    const db = buildDb([
      [], // idempotency guard returns no existing credential
    ]);

    await processCredentialPipeline(
      { db, logger: { info: vi.fn(), error: vi.fn() } },
      {
        flow: 'b2b',
        kycSessionId: '22222222-2222-4222-8222-222222222222',
        firmId: '33333333-3333-4333-8333-333333333333',
        userRef: 'firm-local-user-99',
        diditSessionId: 'didit-session-b2b',
        phase: 'identity',
      },
    );

    // Chain mint fired exactly once with the firm-supplied userRef.
    expect(fheCreateCredentialSpy).toHaveBeenCalledTimes(1);
    const mintCalls = fheCreateCredentialSpy.mock.calls as unknown as Array<unknown[]>;
    const mintArgs = mintCalls[0]![0] as Record<string, unknown>;
    expect(mintArgs['userRef']).toBe('firm-local-user-99');
    expect(mintArgs['level']).toBe('basic'); // phase=identity
    expect(mintArgs['proofHash']).toBe('abcdef0123456789');
    expect(mintArgs['validator']).toBe('didit');

    // Meta INSERT carries the firm + userRef + freshly-fetched blob
    // bytes (the worker base64-decodes the bundle's blobBase64 into
    // a Buffer when storing).
    expect(insertCredentialMetaSpy).toHaveBeenCalledTimes(1);
    const insertCalls = insertCredentialMetaSpy.mock.calls as unknown as Array<unknown[]>;
    const insertArgs = insertCalls[0]![1] as Record<string, unknown>;
    expect(insertArgs['firmId']).toBe('33333333-3333-4333-8333-333333333333');
    expect(insertArgs['userRef']).toBe('firm-local-user-99');
    expect(insertArgs['chainContractId']).toBe(TX_HASH);
    expect(insertArgs['validator']).toBe('didit');
    expect(insertArgs['level']).toBe('basic');
    expect((insertArgs['disclosureBlobCache'] as Buffer).length).toBeGreaterThan(0);

    // The firm-targeted webhook event carries the canonical view
    // shape — blob present, contractId present, proofHash present —
    // PLUS the session-extras (sessionId, workflow, approvedAt).
    expect(emitFirmEventSpy).toHaveBeenCalledTimes(1);
    // emitFirmEvent signature: (db, input) — index 1 carries the
    // event input object.
    const emitCalls = emitFirmEventSpy.mock.calls as unknown as Array<unknown[]>;
    const emitArgs = emitCalls[0]![1] as {
      firmId: string;
      type: string;
      payload: Record<string, unknown>;
    };
    expect(emitArgs.firmId).toBe('33333333-3333-4333-8333-333333333333');
    expect(emitArgs.type).toBe('kyc.session.approved');
    expect(emitArgs.payload['credentialId']).toBe('11111111-1111-4111-8111-111111111111');
    expect(emitArgs.payload['contractId']).toBe(TX_HASH);
    expect(emitArgs.payload['userRef']).toBe('firm-local-user-99');
    expect(emitArgs.payload['proofHash']).toBe('abcdef0123456789');
    expect(emitArgs.payload['level']).toBe('basic');
    expect(emitArgs.payload['validator']).toBe('didit');
    expect(emitArgs.payload['network']).toBe('sepolia');
    // Blob round-trips through base64url back to a non-empty string.
    expect(typeof emitArgs.payload['disclosureBlob']).toBe('string');
    expect(emitArgs.payload['disclosureBlob']).not.toBe('');
    // Session-extras layered on top of the canonical credential view.
    expect(emitArgs.payload['sessionId']).toBe('22222222-2222-4222-8222-222222222222');
    expect(emitArgs.payload['workflow']).toBe('identity');
    expect(typeof emitArgs.payload['approvedAt']).toBe('string');
  });

  it('skips the guard query when CRIVACY_SELF_SERVICE_FIRM_ID is unset', async () => {
    // Env missing — guard is inert and the worker falls through to
    // the normal pipeline (which, further down, throws its own
    // config-missing error at row-insert time). We pin the guard's
    // documented behaviour by counting DB reads: the customer
    // lookup fires, but the guard's second SELECT does NOT — the
    // queue returns its `[]` fallback for any trailing read,
    // proving the guard branch was skipped entirely.
    delete process.env['CRIVACY_SELF_SERVICE_FIRM_ID'];

    let selectCallCount = 0;
    const builder = {
      select: () => {
        selectCallCount++;
        return {
          from: () => ({
            where: () => ({
              // Customer lookup (first call) returns a row; anything
              // after is stubbed with an empty result so the worker
              // doesn't crash — we're only measuring reach, not
              // completion.
              limit: async () =>
                selectCallCount === 1
                  ? [
                      {
                        id: 'customer-uuid',
                        kycFieldsLocked: false,
                        kycLevel: 'kyc_0',
                        kycScore: 0,
                      },
                    ]
                  : [],
            }),
          }),
        };
      },
    };
    const db = builder as unknown as Parameters<typeof processCredentialPipeline>[0]['db'];

    // Don't care that the pipeline fails further down; we're only
    // measuring whether the guard ran.
    await processCredentialPipeline(
      { db, logger: { info: vi.fn(), error: vi.fn() } },
      {
        kycSessionId: 'session-uuid',
        customerId: 'customer-uuid',
        diditSessionId: 'didit-session-abc',
        phase: 'identity',
      },
    ).catch(() => undefined);

    // Exactly ONE select: the customer lookup. The guard branch
    // would have added a second — the env miss kept it closed.
    expect(selectCallCount).toBe(1);

    // Chain was not touched either (the guard doesn't reach
    // Chain, and the worker fails further down before any mint).
    expect(fheCreateCredentialSpy).not.toHaveBeenCalled();
  });
});
