/**
 * Tests for the canonical `parseSessionVendorData` helper —
 * single source of truth for vendor_data parsing across BOTH the
 * inbound webhook handler and the face-match cascade lookup.
 *
 * The test fixtures intentionally mirror the **exact** field set
 * stamped on the wire by:
 *
 *   - `customer-kyc.ts::handleStartIdentity`        (customer)
 *   - `sessions.ts::handleStartIdentity`            (B2B identity)
 *
 * If the producer side ever renames a field (`crivacySessionId` →
 * something else) WITHOUT touching the parser, these tests fail.
 * They are the regression bar for the silent-mint slip we hit
 * pre-Sprint-6: webhook parser looked for `crivacyKycSessionId`,
 * session creator wrote `crivacySessionId`, the mismatch went
 * undetected because the existing webhook test mocked the legacy
 * field name.
 */

import { describe, expect, it } from 'vitest';

import { parseSessionVendorData } from '@crivacy-fhe/adapter-didit/vendor-data';

const SESSION_ID = 'a1111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = 'c2222222-1111-4111-8111-111111111111';
const FIRM_ID = 'f3333333-1111-4111-8111-111111111111';

describe('parseSessionVendorData — customer shape', () => {
  it('parses a JSON-string customer payload', () => {
    const raw = JSON.stringify({
      type: 'customer',
      crivacySessionId: SESSION_ID,
      customerId: CUSTOMER_ID,
    });
    expect(parseSessionVendorData(raw)).toEqual({
      type: 'customer',
      crivacySessionId: SESSION_ID,
      customerId: CUSTOMER_ID,
    });
  });

  it('parses a pre-parsed object customer payload', () => {
    const raw = {
      type: 'customer',
      crivacySessionId: SESSION_ID,
      customerId: CUSTOMER_ID,
    };
    expect(parseSessionVendorData(raw)).toEqual({
      type: 'customer',
      crivacySessionId: SESSION_ID,
      customerId: CUSTOMER_ID,
    });
  });

  it('rejects customer payload missing customerId', () => {
    expect(
      parseSessionVendorData({ type: 'customer', crivacySessionId: SESSION_ID }),
    ).toBeNull();
  });

  it('rejects customer payload with empty customerId', () => {
    expect(
      parseSessionVendorData({
        type: 'customer',
        crivacySessionId: SESSION_ID,
        customerId: '',
      }),
    ).toBeNull();
  });
});

describe('parseSessionVendorData — b2b shape', () => {
  it('parses a JSON-string b2b payload', () => {
    const raw = JSON.stringify({
      type: 'b2b',
      crivacySessionId: SESSION_ID,
      firmId: FIRM_ID,
      userRef: 'user-ref-1',
    });
    expect(parseSessionVendorData(raw)).toEqual({
      type: 'b2b',
      crivacySessionId: SESSION_ID,
      firmId: FIRM_ID,
      userRef: 'user-ref-1',
    });
  });

  it('parses a pre-parsed object b2b payload', () => {
    const raw = {
      type: 'b2b',
      crivacySessionId: SESSION_ID,
      firmId: FIRM_ID,
      userRef: 'user-ref-1',
    };
    expect(parseSessionVendorData(raw)).toEqual({
      type: 'b2b',
      crivacySessionId: SESSION_ID,
      firmId: FIRM_ID,
      userRef: 'user-ref-1',
    });
  });

  it('rejects b2b payload missing firmId', () => {
    expect(
      parseSessionVendorData({
        type: 'b2b',
        crivacySessionId: SESSION_ID,
        userRef: 'user-ref-1',
      }),
    ).toBeNull();
  });

  it('rejects b2b payload missing userRef', () => {
    expect(
      parseSessionVendorData({
        type: 'b2b',
        crivacySessionId: SESSION_ID,
        firmId: FIRM_ID,
      }),
    ).toBeNull();
  });

  // REGRESSION GUARD — the silent-mint slip:
  // The webhook handler used to look for `crivacyKycSessionId` (a
  // field name nobody on the producer side has ever written). This
  // test pins the canonical key so a future rename on either side
  // tears the same bug down again.
  it('rejects legacy crivacyKycSessionId-only payload (regression guard)', () => {
    expect(
      parseSessionVendorData({
        crivacyKycSessionId: SESSION_ID,
      }),
    ).toBeNull();
  });
});

describe('parseSessionVendorData — malformed input', () => {
  it('returns null for a non-JSON string', () => {
    expect(parseSessionVendorData('not-json')).toBeNull();
    expect(parseSessionVendorData('{')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseSessionVendorData('')).toBeNull();
  });

  it('returns null for non-object JSON values', () => {
    expect(parseSessionVendorData('"a-string"')).toBeNull();
    expect(parseSessionVendorData('[1,2,3]')).toBeNull();
    expect(parseSessionVendorData('42')).toBeNull();
    expect(parseSessionVendorData('null')).toBeNull();
  });

  it('returns null for null / undefined / non-object', () => {
    expect(parseSessionVendorData(null)).toBeNull();
    expect(parseSessionVendorData(undefined)).toBeNull();
    expect(parseSessionVendorData(42)).toBeNull();
    expect(parseSessionVendorData([1, 2, 3])).toBeNull();
  });

  it('returns null for unknown type discriminant', () => {
    expect(
      parseSessionVendorData({
        type: 'partner',
        crivacySessionId: SESSION_ID,
      }),
    ).toBeNull();
  });

  it('returns null for missing type', () => {
    expect(parseSessionVendorData({ crivacySessionId: SESSION_ID })).toBeNull();
  });

  it('returns null for missing crivacySessionId', () => {
    expect(
      parseSessionVendorData({ type: 'customer', customerId: CUSTOMER_ID }),
    ).toBeNull();
  });
});
