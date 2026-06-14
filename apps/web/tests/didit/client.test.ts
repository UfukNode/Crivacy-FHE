/**
 * Tests for the Didit client facade.
 *
 * The facade bundles a `DiditConfig` + a `FetchLike` + a `Clock`
 * into a single object. Its contract is:
 *
 *   * Frozen after `createDiditClient` (no monkey-patching)
 *   * Every method is a pure function of the injected deps + args
 *   * Each method delegates to the matching lower-level function
 *     with the bound config / fetch / clock
 *   * `getDiditClient` is a process-lifetime singleton, gated by
 *     `resetDiditClientForTests` in tests
 *   * `buildDiditClientFromEnv` bypasses the singleton cache, used
 *     for bootstrap checks
 *
 * Every test drives the facade through the fake fetch + fixture
 * clock — no real HTTP, no real env reads.
 */

import { describe, expect, it } from 'vitest';

import {
  DiditError,
  asDiditSessionIdUnchecked,
  asDiditVendorDataUnchecked,
  buildDiditClientFromEnv,
  createDiditClient,
  getDiditClient,
  isDiditErrorWithCode,
  resetDiditClientForTests,
  resetDiditConfigForTests,
} from '@crivacy-fhe/adapter-didit';

import {
  FIXTURE_ADDRESS_WORKFLOW_ID,
  FIXTURE_API_KEY,
  FIXTURE_BASE_URL,
  FIXTURE_CALLBACK_URL,
  FIXTURE_KYC_WORKFLOW_ID,
  FIXTURE_SESSION_ID,
  FIXTURE_VENDOR_DATA,
  FIXTURE_WEBHOOK_SECRET,
  buildAddressDecisionBody,
  buildAddressDecisionPayload,
  buildCreateSessionResponseBody,
  buildFakeFetch,
  buildKycDecisionBody,
  buildKycDecisionPayload,
  buildSignedWebhookInput,
  buildTestConfig,
  buildWebhookBody,
  fixtureClock,
} from './fixtures';

/* ---------- createDiditClient — shape + freeze ---------- */

describe('createDiditClient — shape', () => {
  it('returns a frozen object', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    expect(Object.isFrozen(client)).toBe(true);
  });

  it('exposes the injected config by reference', () => {
    const config = buildTestConfig();
    const client = createDiditClient({ config });
    expect(client.config).toBe(config);
  });

  it('exposes validation helpers directly', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    expect(client.validateVendorData(FIXTURE_VENDOR_DATA)).toBe(FIXTURE_VENDOR_DATA);
    expect(client.validateSessionId(FIXTURE_SESSION_ID)).toBe(FIXTURE_SESSION_ID);
    expect(client.validateWorkflowIdShape(FIXTURE_KYC_WORKFLOW_ID)).toBe(FIXTURE_KYC_WORKFLOW_ID);
  });

  it('refuses to be monkey-patched at runtime', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    expect(() => {
      (client as unknown as Record<string, unknown>)['newMethod'] = () => 'hacked';
    }).toThrow();
  });
});

/* ---------- createDiditClient — session create ---------- */

describe('createDiditClient — createKycSession', () => {
  it('issues the POST through the injected fetch', async () => {
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', body: buildCreateSessionResponseBody() });
    const client = createDiditClient({ config: buildTestConfig(), fetch: handle.fetch });

    const vendorData = client.validateVendorData(FIXTURE_VENDOR_DATA);
    const result = await client.createKycSession(vendorData, FIXTURE_CALLBACK_URL);

    expect(result.sessionId).toBe(FIXTURE_SESSION_ID);
    expect(result.workflowType).toBe('kyc');
    expect(handle.captured).toHaveLength(1);
    const captured = handle.captured[0];
    if (captured === undefined) {
      throw new Error('expected captured');
    }
    expect(captured.headers['x-api-key']).toBe(FIXTURE_API_KEY);
    expect((captured.body as Record<string, unknown>)['workflow_id']).toBe(FIXTURE_KYC_WORKFLOW_ID);
  });
});

describe('createDiditClient — createAddressSession', () => {
  it('uses the configured Address workflow id', async () => {
    const handle = buildFakeFetch();
    handle.enqueue({
      kind: 'json',
      body: buildCreateSessionResponseBody({ workflow_id: FIXTURE_ADDRESS_WORKFLOW_ID }),
    });
    const client = createDiditClient({ config: buildTestConfig(), fetch: handle.fetch });

    const vendorData = client.validateVendorData(FIXTURE_VENDOR_DATA);
    const result = await client.createAddressSession(vendorData, FIXTURE_CALLBACK_URL);
    expect(result.workflowType).toBe('address');
    expect(result.workflowId).toBe(FIXTURE_ADDRESS_WORKFLOW_ID);
  });
});

/* ---------- createDiditClient — decision fetch ---------- */

describe('createDiditClient — getDecision', () => {
  it('GETs the correct path and returns a hydrated payload', async () => {
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', body: buildKycDecisionBody() });
    const client = createDiditClient({ config: buildTestConfig(), fetch: handle.fetch });

    const sessionId = client.validateSessionId(FIXTURE_SESSION_ID);
    const decision = await client.getDecision(sessionId);

    expect(decision.workflowType).toBe('kyc');
    expect(decision.status).toBe('Approved');
    const captured = handle.captured[0];
    if (captured === undefined) {
      throw new Error('expected captured');
    }
    expect(captured.method).toBe('GET');
    expect(captured.path).toBe(`/v3/session/${FIXTURE_SESSION_ID}/decision/`);
  });

  it('retries the decision GET on a transient 5xx', async () => {
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 503, body: { detail: 'x' } });
    handle.enqueue({ kind: 'json', body: buildAddressDecisionBody() });
    const client = createDiditClient({
      config: buildTestConfig({ DIDIT_MAX_RETRIES: '2' }),
      fetch: handle.fetch,
    });

    const sessionId = client.validateSessionId(FIXTURE_SESSION_ID);
    const decision = await client.getDecision(sessionId);
    expect(decision.workflowType).toBe('address');
    expect(handle.captured).toHaveLength(2);
  });
});

/* ---------- createDiditClient — webhook ---------- */

describe('createDiditClient — verifyWebhook', () => {
  it('verifies a correctly-signed webhook using the injected clock', () => {
    const client = createDiditClient({
      config: buildTestConfig(),
      clock: fixtureClock,
    });

    const body = buildWebhookBody();
    const input = buildSignedWebhookInput(FIXTURE_WEBHOOK_SECRET, body);
    const result = client.verifyWebhook(input);
    expect(result.scheme).toBe('v2');
  });

  it('uses the default clock when none is injected', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    // Build a fresh signature with a timestamp at "now" from the
    // real clock so the default `Date.now()` path passes freshness.
    // body.timestamp must mirror the header — AUD-INT-REPLAY-001
    // consistency check.
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const nowIso = new Date(nowSeconds * 1000).toISOString();
    const body = buildWebhookBody({ timestamp: nowIso });
    const input = buildSignedWebhookInput(FIXTURE_WEBHOOK_SECRET, body, {
      'x-timestamp': String(nowSeconds),
    });
    const result = client.verifyWebhook(input);
    expect(result.timestamp).toBe(nowSeconds);
  });

  it('throws invalid_signature on a bad HMAC via the facade', () => {
    const client = createDiditClient({
      config: buildTestConfig(),
      clock: fixtureClock,
    });
    const body = buildWebhookBody();
    const input = buildSignedWebhookInput(FIXTURE_WEBHOOK_SECRET, body, {
      'x-signature-v2': 'b'.repeat(64),
    });
    try {
      client.verifyWebhook(input);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_signature')).toBe(true);
    }
  });

  it('exposes parseWebhookBody directly', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    const parsed = client.parseWebhookBody(buildWebhookBody());
    expect(parsed.status).toBe('Approved');
  });
});

/* ---------- createDiditClient — mapping + proof hash ---------- */

describe('createDiditClient — mapping helpers', () => {
  it('reduces a decision via the facade', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    const flags = client.reduceDecision(buildKycDecisionPayload());
    expect(flags.outcome).toBe('passed');
    expect(flags.identityVerified).toBe(true);
  });

  it('merges verification flags via the facade', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    const kyc = client.reduceDecision(buildKycDecisionPayload());
    const addr = client.reduceDecision(buildAddressDecisionPayload());
    const merged = client.mergeVerificationFlags([kyc, addr]);
    expect(merged.outcome).toBe('passed');
    expect(merged.identityVerified).toBe(true);
    expect(merged.addressVerified).toBe(true);
  });

  it('computes a proof hash using the bound config', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    const hash = client.computeProofHash(buildKycDecisionPayload());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws invalid_proof_input when strict mode rejects missing fields', () => {
    const client = createDiditClient({
      config: buildTestConfig({ DIDIT_PROOF_HASH_STRICT: 'true' }),
    });
    expect(() =>
      client.computeProofHash(
        buildKycDecisionPayload({
          kyc: {
            documentType: null,
            documentNumber: null,
            issuingCountry: null,
            firstName: null,
            lastName: null,
            dateOfBirth: null,
          },
        }),
      ),
    ).toThrow(DiditError);
  });

  it('detects the workflow type via the facade', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    expect(client.detectWorkflowType(FIXTURE_KYC_WORKFLOW_ID)).toBe('kyc');
    expect(client.detectWorkflowType(FIXTURE_ADDRESS_WORKFLOW_ID)).toBe('address');
  });
});

/* ---------- createDiditClient — validation error propagation ---------- */

describe('createDiditClient — validation errors', () => {
  it('surfaces invalid_vendor_data from validateVendorData', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    try {
      client.validateVendorData('');
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_vendor_data')).toBe(true);
    }
  });

  it('surfaces invalid_session_id from validateSessionId', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    try {
      client.validateSessionId('');
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_session_id')).toBe(true);
    }
  });

  it('surfaces invalid_workflow_id from validateWorkflowIdShape', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    try {
      client.validateWorkflowIdShape('not-a-uuid');
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_workflow_id')).toBe(true);
    }
  });

  it('surfaces invalid_callback_url from createKycSession', () => {
    const handle = buildFakeFetch();
    const client = createDiditClient({ config: buildTestConfig(), fetch: handle.fetch });
    const vendorData = asDiditVendorDataUnchecked(FIXTURE_VENDOR_DATA);
    // The facade delegates to createKycSession which validates the
    // callback URL synchronously before constructing the returned
    // promise, so the throw surfaces as a sync exception.
    try {
      void client.createKycSession(vendorData, 'ftp://bad');
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_callback_url')).toBe(true);
    }
    expect(handle.captured).toHaveLength(0);
  });
});

/* ---------- getDiditClient — singleton ---------- */

describe('getDiditClient — singleton', () => {
  // All these tests manipulate process.env so they must clean up
  // after themselves. The resetDiditClientForTests call drops the
  // cached singleton + resetDiditConfigForTests drops the cached
  // config so a second call reloads from the new env.
  function setEnv(): void {
    process.env['DIDIT_API_KEY'] = FIXTURE_API_KEY;
    process.env['DIDIT_KYC_WORKFLOW_ID'] = FIXTURE_KYC_WORKFLOW_ID;
    process.env['DIDIT_ADDRESS_WORKFLOW_ID'] = FIXTURE_ADDRESS_WORKFLOW_ID;
    process.env['DIDIT_WEBHOOK_SECRET'] = FIXTURE_WEBHOOK_SECRET;
    process.env['DIDIT_DEFAULT_CALLBACK_URL'] = FIXTURE_CALLBACK_URL;
    process.env['DIDIT_BASE_URL'] = FIXTURE_BASE_URL;
  }

  function clearEnv(): void {
    Reflect.deleteProperty(process.env, 'DIDIT_API_KEY');
    Reflect.deleteProperty(process.env, 'DIDIT_KYC_WORKFLOW_ID');
    Reflect.deleteProperty(process.env, 'DIDIT_ADDRESS_WORKFLOW_ID');
    Reflect.deleteProperty(process.env, 'DIDIT_WEBHOOK_SECRET');
    Reflect.deleteProperty(process.env, 'DIDIT_DEFAULT_CALLBACK_URL');
    Reflect.deleteProperty(process.env, 'DIDIT_BASE_URL');
  }

  it('caches the first instance', () => {
    setEnv();
    try {
      resetDiditClientForTests();
      resetDiditConfigForTests();
      const first = getDiditClient();
      const second = getDiditClient();
      expect(first).toBe(second);
    } finally {
      resetDiditClientForTests();
      resetDiditConfigForTests();
      clearEnv();
    }
  });

  it('reloads after resetDiditClientForTests', () => {
    setEnv();
    try {
      resetDiditClientForTests();
      resetDiditConfigForTests();
      const first = getDiditClient();
      resetDiditClientForTests();
      const second = getDiditClient();
      expect(first).not.toBe(second);
      expect(second.config.apiKey).toBe(first.config.apiKey);
    } finally {
      resetDiditClientForTests();
      resetDiditConfigForTests();
      clearEnv();
    }
  });
});

/* ---------- buildDiditClientFromEnv ---------- */

describe('buildDiditClientFromEnv', () => {
  it('builds a client from an explicit env record without touching the singleton', () => {
    resetDiditClientForTests();
    const client = buildDiditClientFromEnv({
      DIDIT_API_KEY: FIXTURE_API_KEY,
      DIDIT_KYC_WORKFLOW_ID: FIXTURE_KYC_WORKFLOW_ID,
      DIDIT_ADDRESS_WORKFLOW_ID: FIXTURE_ADDRESS_WORKFLOW_ID,
      DIDIT_WEBHOOK_SECRET: FIXTURE_WEBHOOK_SECRET,
      DIDIT_DEFAULT_CALLBACK_URL: FIXTURE_CALLBACK_URL,
      DIDIT_BASE_URL: FIXTURE_BASE_URL,
    });
    expect(client.config.apiKey).toBe(FIXTURE_API_KEY);
    expect(client.config.kycWorkflowId).toBe(FIXTURE_KYC_WORKFLOW_ID);
    // Calling buildDiditClientFromEnv must not pollute the singleton.
    // We can't directly check that without env setup, so just verify
    // two successive calls produce different instances.
    const other = buildDiditClientFromEnv({
      DIDIT_API_KEY: FIXTURE_API_KEY,
      DIDIT_KYC_WORKFLOW_ID: FIXTURE_KYC_WORKFLOW_ID,
      DIDIT_ADDRESS_WORKFLOW_ID: FIXTURE_ADDRESS_WORKFLOW_ID,
      DIDIT_WEBHOOK_SECRET: FIXTURE_WEBHOOK_SECRET,
      DIDIT_DEFAULT_CALLBACK_URL: FIXTURE_CALLBACK_URL,
      DIDIT_BASE_URL: FIXTURE_BASE_URL,
    });
    expect(client).not.toBe(other);
    resetDiditClientForTests();
  });

  it('throws invalid_config on a malformed env', () => {
    expect(() =>
      buildDiditClientFromEnv({
        DIDIT_API_KEY: FIXTURE_API_KEY,
        DIDIT_KYC_WORKFLOW_ID: 'not-a-uuid',
        DIDIT_ADDRESS_WORKFLOW_ID: FIXTURE_ADDRESS_WORKFLOW_ID,
        DIDIT_WEBHOOK_SECRET: FIXTURE_WEBHOOK_SECRET,
        DIDIT_DEFAULT_CALLBACK_URL: FIXTURE_CALLBACK_URL,
      }),
    ).toThrow(DiditError);
  });
});

/* ---------- isolation ---------- */

describe('createDiditClient — isolation', () => {
  it('two clients built with different configs stay independent', () => {
    const a = createDiditClient({ config: buildTestConfig({ DIDIT_MAX_RETRIES: '0' }) });
    const b = createDiditClient({ config: buildTestConfig({ DIDIT_MAX_RETRIES: '3' }) });
    expect(a.config.maxRetries).toBe(0);
    expect(b.config.maxRetries).toBe(3);
  });

  it('unchecked branded ids flow through validation methods unchanged', () => {
    const client = createDiditClient({ config: buildTestConfig() });
    const raw = asDiditSessionIdUnchecked(FIXTURE_SESSION_ID);
    expect(raw).toBe(FIXTURE_SESSION_ID);
    expect(client.validateSessionId(raw)).toBe(FIXTURE_SESSION_ID);
  });
});
