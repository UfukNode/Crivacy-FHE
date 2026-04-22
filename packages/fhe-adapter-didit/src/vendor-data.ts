/**
 * Single source of truth for parsing the `vendor_data` blob that we
 * stamp on every Didit session at creation time and that Didit echoes
 * back on:
 *
 *   - inbound webhook bodies (`POST /api/webhooks/didit` → the session
 *     whose decision is being delivered);
 *   - face_search match entries (`decision.face_search.matches[].vendor_data`
 *     → the matched session's vendor_data, used by the Sprint 6
 *     face-match cascade lookup).
 *
 * Both call sites parse the SAME JSON shape — they just receive it
 * from different places in the Didit payload. Keeping the parser in
 * one place avoids the slip we hit before Sprint 6 closure: the
 * webhook parser was looking for a field name (`crivacyKycSessionId`)
 * that the session creators never wrote, so B2B webhook decisions
 * silently dropped on the floor.
 *
 * Canonical shapes (set when WE create the session — see
 * `customer-kyc.ts` and `sessions.ts`):
 *
 *   Customer: { crivacySessionId, type: 'customer', customerId }
 *   B2B:      { crivacySessionId, type: 'b2b', firmId, userRef }
 *
 * Returns `null` when:
 *   - input is not a JSON-string OR a plain object (Didit echoes it
 *     either way depending on path / SDK);
 *   - JSON parse fails / value is not an object;
 *   - missing or empty `crivacySessionId`;
 *   - `type` is missing / unknown;
 *   - per-type required fields are missing or empty.
 *
 * Callers treat `null` as "unknown / not-our-session" and skip the
 * downstream logic gracefully (no 5xx, no Didit retry storm).
 *
 * @module
 */

export type ParsedSessionVendorData =
  | {
      readonly type: 'customer';
      readonly crivacySessionId: string;
      readonly customerId: string;
    }
  | {
      readonly type: 'b2b';
      readonly crivacySessionId: string;
      readonly firmId: string;
      readonly userRef: string;
    };

/**
 * Parse a Didit `vendor_data` value. Accepts both the JSON-string
 * form (push channel) and the parsed-object form (some SDKs surface
 * it pre-parsed).
 */
export function parseSessionVendorData(raw: unknown): ParsedSessionVendorData | null {
  let obj: Record<string, unknown> | null = null;

  if (typeof raw === 'string') {
    if (raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      obj = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else {
    return null;
  }

  const crivacySessionId = obj['crivacySessionId'];
  if (typeof crivacySessionId !== 'string' || crivacySessionId.length === 0) {
    return null;
  }

  const type = obj['type'];
  if (type === 'customer') {
    const customerId = obj['customerId'];
    if (typeof customerId !== 'string' || customerId.length === 0) return null;
    return { type: 'customer', crivacySessionId, customerId };
  }
  if (type === 'b2b') {
    const firmId = obj['firmId'];
    const userRef = obj['userRef'];
    if (
      typeof firmId !== 'string' ||
      firmId.length === 0 ||
      typeof userRef !== 'string' ||
      userRef.length === 0
    ) {
      return null;
    }
    return { type: 'b2b', crivacySessionId, firmId, userRef };
  }
  return null;
}
