/**
 * Tests for the Didit session create + decision fetch layer.
 *
 * This module is the high-level write layer. We drive it through
 * the fake fetch (no real HTTP) and assert:
 *
 *   * Input validation (vendor_data, callback_url, session_id,
 *     workflow_id) — each validator has its own error code and
 *     rejects the obvious bad shapes.
 *   * `createKycSession` / `createAddressSession` build the correct
 *     POST body (workflow_id, vendor_data, callback, callback_method)
 *     and return a branded, frozen result.
 *   * `workflowIdToType` maps configured ids to tags and returns
 *     `null` for anything else.
 *   * `resolveWorkflowType` fails closed by default and is lenient
 *     only when the config flag is explicitly disabled.
 *   * `hydrateDecisionResponse` freezes every nested block and
 *     normalizes float scores to integers.
 *   * `getDecision` builds the correct path, parses the body, and
 *     returns the hydrated payload.
 */

import { describe, expect, it } from 'vitest';

import {
  DecisionResponseSchema,
  DiditError,
  createAddressSession,
  createKycSession,
  getDecision,
  hydrateDecisionResponse,
  isDiditErrorWithCode,
  resolveWorkflowType,
  validateCallbackUrl,
  validateSessionId,
  validateVendorData,
  validateWorkflowId,
  workflowIdToType,
} from '@crivacy-fhe/adapter-didit';

import {
  FIXTURE_ADDRESS_WORKFLOW_ID,
  FIXTURE_CALLBACK_URL,
  FIXTURE_KYC_WORKFLOW_ID,
  FIXTURE_SESSION_ID,
  FIXTURE_VENDOR_DATA,
  buildAddressDecisionBody,
  buildCreateSessionResponseBody,
  buildFakeFetch,
  buildKycDecisionBody,
  buildTestConfig,
} from './fixtures';

/* ---------- validateVendorData ---------- */

describe('validateVendorData', () => {
  it('accepts a printable-ASCII string', () => {
    const v = validateVendorData('user_abc123');
    expect(v).toBe('user_abc123');
  });

  it('rejects an empty string', () => {
    expect(() => validateVendorData('')).toThrow(DiditError);
    try {
      validateVendorData('');
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_vendor_data')).toBe(true);
    }
  });

  it('rejects a string longer than 512 chars', () => {
    expect(() => validateVendorData('a'.repeat(513))).toThrow(DiditError);
  });

  it('rejects a non-string input', () => {
    expect(() => validateVendorData(42 as unknown as string)).toThrow(DiditError);
  });

  it('rejects a string with a non-printable character', () => {
    expect(() => validateVendorData('user\x00hidden')).toThrow(DiditError);
  });

  it('rejects a string with a DEL character', () => {
    expect(() => validateVendorData('user\x7f')).toThrow(DiditError);
  });

  it('rejects a string with a non-ASCII character', () => {
    expect(() => validateVendorData('userß')).toThrow(DiditError);
  });

  it('accepts the max-length boundary', () => {
    expect(validateVendorData('a'.repeat(512))).toBe('a'.repeat(512));
  });
});

/* ---------- validateCallbackUrl ---------- */

describe('validateCallbackUrl', () => {
  it('accepts an https URL', () => {
    expect(validateCallbackUrl('https://app.test/crv')).toBe('https://app.test/crv');
  });

  it('accepts an http URL (for local fixtures)', () => {
    expect(validateCallbackUrl('http://127.0.0.1:3000/cb')).toBe('http://127.0.0.1:3000/cb');
  });

  it('rejects an ftp URL', () => {
    expect(() => validateCallbackUrl('ftp://app.test/cb')).toThrow(DiditError);
    try {
      validateCallbackUrl('ftp://app.test/cb');
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_callback_url')).toBe(true);
    }
  });

  it('rejects an empty string', () => {
    expect(() => validateCallbackUrl('')).toThrow(DiditError);
  });

  it('rejects a malformed URL', () => {
    expect(() => validateCallbackUrl('not a url')).toThrow(DiditError);
  });

  it('rejects a non-string input', () => {
    expect(() => validateCallbackUrl(null as unknown as string)).toThrow(DiditError);
  });
});

/* ---------- validateWorkflowId ---------- */

describe('validateWorkflowId', () => {
  it('accepts the canonical lowercase UUID', () => {
    expect(validateWorkflowId(FIXTURE_KYC_WORKFLOW_ID)).toBe(FIXTURE_KYC_WORKFLOW_ID);
  });

  it('rejects the uppercase form', () => {
    expect(() => validateWorkflowId(FIXTURE_KYC_WORKFLOW_ID.toUpperCase())).toThrow(DiditError);
  });

  it('rejects a non-UUID string', () => {
    expect(() => validateWorkflowId('not-a-uuid')).toThrow(DiditError);
  });

  it('rejects an empty string', () => {
    expect(() => validateWorkflowId('')).toThrow(DiditError);
  });
});

/* ---------- validateSessionId ---------- */

describe('validateSessionId', () => {
  it('accepts the fixture session id', () => {
    expect(validateSessionId(FIXTURE_SESSION_ID)).toBe(FIXTURE_SESSION_ID);
  });

  it('rejects an empty string', () => {
    expect(() => validateSessionId('')).toThrow(DiditError);
  });

  it('rejects a string longer than 256 chars', () => {
    expect(() => validateSessionId('s'.repeat(257))).toThrow(DiditError);
  });

  it('rejects a non-printable character', () => {
    expect(() => validateSessionId('sess\x01')).toThrow(DiditError);
  });
});

/* ---------- workflowIdToType ---------- */

describe('workflowIdToType', () => {
  it('maps the configured KYC id to "kyc"', () => {
    const config = buildTestConfig();
    expect(workflowIdToType(config, FIXTURE_KYC_WORKFLOW_ID)).toBe('kyc');
  });

  it('maps the configured Address id to "address"', () => {
    const config = buildTestConfig();
    expect(workflowIdToType(config, FIXTURE_ADDRESS_WORKFLOW_ID)).toBe('address');
  });

  it('returns null for an unknown id', () => {
    const config = buildTestConfig();
    expect(workflowIdToType(config, '00000000-0000-0000-0000-000000000000')).toBe(null);
  });
});

/* ---------- resolveWorkflowType ---------- */

describe('resolveWorkflowType', () => {
  it('returns the type for a configured id', () => {
    const config = buildTestConfig();
    expect(resolveWorkflowType(config, FIXTURE_KYC_WORKFLOW_ID)).toBe('kyc');
    expect(resolveWorkflowType(config, FIXTURE_ADDRESS_WORKFLOW_ID)).toBe('address');
  });

  it('fails closed on an unknown id by default', () => {
    const config = buildTestConfig();
    expect(() => resolveWorkflowType(config, '00000000-0000-0000-0000-000000000000')).toThrow(
      DiditError,
    );
    try {
      resolveWorkflowType(config, '00000000-0000-0000-0000-000000000000');
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'unknown_workflow')).toBe(true);
    }
  });

  it('falls through to kyc when fail-closed is disabled', () => {
    const config = buildTestConfig({ DIDIT_FAIL_CLOSED_ON_UNKNOWN_WORKFLOW: 'false' });
    expect(resolveWorkflowType(config, '00000000-0000-0000-0000-000000000000')).toBe('kyc');
  });
});

/* ---------- createKycSession ---------- */

describe('createKycSession', () => {
  it('posts to /v3/session/ with the configured KYC workflow id', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', body: buildCreateSessionResponseBody() });

    const vendorData = validateVendorData(FIXTURE_VENDOR_DATA);
    const result = await createKycSession(
      config,
      vendorData,
      FIXTURE_CALLBACK_URL,
      undefined,
      handle.fetch,
    );

    expect(result.sessionId).toBe(FIXTURE_SESSION_ID);
    expect(result.workflowType).toBe('kyc');
    expect(result.workflowId).toBe(FIXTURE_KYC_WORKFLOW_ID);
    expect(result.vendorData).toBe(FIXTURE_VENDOR_DATA);

    expect(handle.captured).toHaveLength(1);
    const captured = handle.captured[0];
    if (captured === undefined) {
      throw new Error('expected captured');
    }
    expect(captured.method).toBe('POST');
    expect(captured.path).toBe('/v3/session/');
    expect(captured.body).toEqual({
      workflow_id: FIXTURE_KYC_WORKFLOW_ID,
      vendor_data: FIXTURE_VENDOR_DATA,
      callback: FIXTURE_CALLBACK_URL,
      callback_method: 'both',
    });
  });

  it('returns a frozen result', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', body: buildCreateSessionResponseBody() });

    const vendorData = validateVendorData(FIXTURE_VENDOR_DATA);
    const result = await createKycSession(
      config,
      vendorData,
      FIXTURE_CALLBACK_URL,
      undefined,
      handle.fetch,
    );
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejects a malformed callback URL before issuing a request', () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    const vendorData = validateVendorData(FIXTURE_VENDOR_DATA);

    // createKycSession validates the callback URL synchronously before
    // constructing the returned promise, so the throw surfaces as a
    // sync exception, not a rejected promise.
    try {
      void createKycSession(config, vendorData, 'not a url', undefined, handle.fetch);
      expect.unreachable();
    } catch (err) {
      expect(isDiditErrorWithCode(err, 'invalid_callback_url')).toBe(true);
    }
    expect(handle.captured).toHaveLength(0);
  });
});

/* ---------- createAddressSession ---------- */

describe('createAddressSession', () => {
  it('uses the configured Address workflow id', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({
      kind: 'json',
      body: buildCreateSessionResponseBody({ workflow_id: FIXTURE_ADDRESS_WORKFLOW_ID }),
    });

    const vendorData = validateVendorData(FIXTURE_VENDOR_DATA);
    const result = await createAddressSession(
      config,
      vendorData,
      FIXTURE_CALLBACK_URL,
      undefined,
      handle.fetch,
    );

    expect(result.workflowType).toBe('address');
    expect(result.workflowId).toBe(FIXTURE_ADDRESS_WORKFLOW_ID);

    const captured = handle.captured[0];
    if (captured === undefined) {
      throw new Error('expected captured');
    }
    expect((captured.body as Record<string, unknown>)['workflow_id']).toBe(
      FIXTURE_ADDRESS_WORKFLOW_ID,
    );
  });

  it('omits expected_details when none is supplied', async () => {
    // Sprint 8 — body must not include expected_details when callers
    // don't pass any. Didit treats absence as "no cross-validation"
    // and skips the name/address mismatch checks.
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({
      kind: 'json',
      body: buildCreateSessionResponseBody({ workflow_id: FIXTURE_ADDRESS_WORKFLOW_ID }),
    });

    const vendorData = validateVendorData(FIXTURE_VENDOR_DATA);
    await createAddressSession(config, vendorData, FIXTURE_CALLBACK_URL, undefined, handle.fetch);

    const captured = handle.captured[0];
    if (captured === undefined) throw new Error('expected captured');
    expect((captured.body as Record<string, unknown>)['expected_details']).toBeUndefined();
  });

  it('injects expected_details with snake_case keys when supplied', async () => {
    // Sprint 8 anchor — when the handler resolves first/last name
    // from the customer's identity decision, those values flow
    // through to the wire as expected_details.{first_name,last_name}.
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({
      kind: 'json',
      body: buildCreateSessionResponseBody({ workflow_id: FIXTURE_ADDRESS_WORKFLOW_ID }),
    });

    const vendorData = validateVendorData(FIXTURE_VENDOR_DATA);
    await createAddressSession(
      config,
      vendorData,
      FIXTURE_CALLBACK_URL,
      { firstName: 'Maria Garcia', lastName: 'Lopez' },
      handle.fetch,
    );

    const captured = handle.captured[0];
    if (captured === undefined) throw new Error('expected captured');
    const body = captured.body as Record<string, unknown>;
    const expected = body['expected_details'] as Record<string, unknown> | undefined;
    expect(expected).toBeDefined();
    expect(expected?.['first_name']).toBe('Maria Garcia');
    expect(expected?.['last_name']).toBe('Lopez');
    // Other expected_details keys are absent when not supplied.
    expect(expected?.['address']).toBeUndefined();
    expect(expected?.['poa_country']).toBeUndefined();
  });

  it('drops empty-string expected_details fields (does not send them)', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({
      kind: 'json',
      body: buildCreateSessionResponseBody({ workflow_id: FIXTURE_ADDRESS_WORKFLOW_ID }),
    });

    const vendorData = validateVendorData(FIXTURE_VENDOR_DATA);
    await createAddressSession(
      config,
      vendorData,
      FIXTURE_CALLBACK_URL,
      { firstName: 'John', lastName: '', address: '' },
      handle.fetch,
    );

    const captured = handle.captured[0];
    if (captured === undefined) throw new Error('expected captured');
    const expected = (captured.body as Record<string, unknown>)['expected_details'] as
      | Record<string, unknown>
      | undefined;
    expect(expected).toBeDefined();
    expect(expected?.['first_name']).toBe('John');
    expect(expected?.['last_name']).toBeUndefined();
    expect(expected?.['address']).toBeUndefined();
  });
});

/* ---------- hydrateDecisionResponse ---------- */

describe('hydrateDecisionResponse', () => {
  it('freezes every nested block on a full KYC decision', () => {
    const config = buildTestConfig();
    const raw = DecisionResponseSchema.parse(buildKycDecisionBody());
    const hydrated = hydrateDecisionResponse(config, raw);
    expect(Object.isFrozen(hydrated)).toBe(true);
    expect(Object.isFrozen(hydrated.kyc)).toBe(true);
    expect(Object.isFrozen(hydrated.liveness)).toBe(true);
    expect(Object.isFrozen(hydrated.faceMatch)).toBe(true);
  });

  it('rounds float scores to integers', () => {
    const config = buildTestConfig();
    const raw = DecisionResponseSchema.parse(
      buildKycDecisionBody({ liveness_score: 98.6, face_match_score: 97.4 }),
    );
    const hydrated = hydrateDecisionResponse(config, raw);
    expect(hydrated.liveness?.score).toBe(99);
    expect(hydrated.faceMatch?.score).toBe(97);
  });

  it('preserves camelCase field names (not snake_case)', () => {
    const config = buildTestConfig();
    const raw = DecisionResponseSchema.parse(buildKycDecisionBody());
    const hydrated = hydrateDecisionResponse(config, raw);
    expect(hydrated.kyc?.documentNumber).toBe('P123456789');
    expect(hydrated.kyc?.issuingCountry).toBe('TUR');
    expect(hydrated.kyc?.firstName).toBe('Ada');
    expect(hydrated.kyc?.lastName).toBe('Lovelace');
    expect(hydrated.kyc?.dateOfBirth).toBe('1815-12-10');
  });

  it('maps an Address decision correctly', () => {
    const config = buildTestConfig();
    const raw = DecisionResponseSchema.parse(buildAddressDecisionBody());
    const hydrated = hydrateDecisionResponse(config, raw);
    expect(hydrated.workflowType).toBe('address');
    expect(hydrated.address?.addressVerified).toBe(true);
    expect(hydrated.address?.country).toBe('TUR');
    expect(hydrated.kyc).toBeNull();
  });

  it('preserves a null humanScore', () => {
    const config = buildTestConfig();
    const raw = DecisionResponseSchema.parse({
      ...buildKycDecisionBody(),
      human_score: null,
    });
    const hydrated = hydrateDecisionResponse(config, raw);
    expect(hydrated.humanScore).toBeNull();
  });

  it('throws unknown_workflow on a workflow id not in config', () => {
    const config = buildTestConfig();
    const raw = DecisionResponseSchema.parse({
      ...buildKycDecisionBody(),
      workflow_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(() => hydrateDecisionResponse(config, raw)).toThrow(DiditError);
  });
});

/* ---------- getDecision ---------- */

describe('getDecision', () => {
  it('GETs the correct path and hydrates the body', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', body: buildKycDecisionBody() });

    const sessionId = validateSessionId(FIXTURE_SESSION_ID);
    const decision = await getDecision(config, sessionId, handle.fetch);

    expect(decision.workflowType).toBe('kyc');
    expect(decision.status).toBe('Approved');

    const captured = handle.captured[0];
    if (captured === undefined) {
      throw new Error('expected captured');
    }
    expect(captured.method).toBe('GET');
    expect(captured.path).toBe(`/v3/session/${FIXTURE_SESSION_ID}/decision/`);
  });

  it('URL-encodes a session id with reserved characters', async () => {
    const config = buildTestConfig();
    const handle = buildFakeFetch();
    handle.enqueue({
      kind: 'json',
      body: buildKycDecisionBody({ session_id: 'sess a b' }),
    });

    const sessionId = validateSessionId('sess a b');
    await getDecision(config, sessionId, handle.fetch);

    const captured = handle.captured[0];
    if (captured === undefined) {
      throw new Error('expected captured');
    }
    expect(captured.path).toBe('/v3/session/sess%20a%20b/decision/');
  });

  it('retries a transient 5xx failure (GET defaults to auto)', async () => {
    const config = buildTestConfig({ DIDIT_MAX_RETRIES: '2' });
    const handle = buildFakeFetch();
    handle.enqueue({ kind: 'json', status: 503, body: { detail: 'x' } });
    handle.enqueue({ kind: 'json', body: buildKycDecisionBody() });

    const sessionId = validateSessionId(FIXTURE_SESSION_ID);
    const decision = await getDecision(config, sessionId, handle.fetch);
    expect(decision.workflowType).toBe('kyc');
    expect(handle.captured).toHaveLength(2);
  });
});
