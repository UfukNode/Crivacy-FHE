/**
 * Identity and address data extraction from Didit decision payloads.
 *
 * Transforms the Didit-side field names (`firstName`, `lastName`,
 * `issuingCountry`, etc.) into the flat shape stored on the `customers`
 * table (`full_name`, `date_of_birth`, `nationality`, `document_type`,
 * `document_country`, `address_line`, `address_city`, `address_country`).
 *
 * Normalization rules:
 *   - Whitespace is trimmed; empty-after-trim collapses to `null`.
 *   - Country codes are uppercased to ISO 3166-1 alpha-2 form.
 *   - `dateOfBirth` is validated as an ISO 8601 date (`YYYY-MM-DD`);
 *     anything that does not match is returned as `null`.
 *   - Missing or non-string fields return `null` — the caller decides
 *     whether a partial result is acceptable.
 *
 * The module is pure: no I/O, no side effects, no exceptions. Consumers
 * (the credential-pipeline worker) check the returned nullability before
 * writing to the DB.
 *
 * @module
 */

import type { DiditDecisionPayload } from './types';

/* ---------- Shared helpers ---------- */

/**
 * Trim a nullable string, returning `null` if the result is empty.
 */
function trimOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize a country code to ISO 3166-1 alpha-2 (uppercase, 2-letter).
 * Returns `null` if the input does not look like a 2-3 character country
 * code. Didit sometimes returns 3-letter ISO 3166-1 alpha-3 codes; we
 * only accept 2-letter here — callers needing alpha-3 conversion should
 * handle it upstream.
 */
function normalizeCountryCode(value: string | null | undefined): string | null {
  const trimmed = trimOrNull(value);
  if (trimmed === null) {
    return null;
  }
  const upper = trimmed.toUpperCase();
  // Accept 2-letter codes only; reject anything else
  if (/^[A-Z]{2}$/.test(upper)) {
    return upper;
  }
  return null;
}

/**
 * Validate an ISO 8601 date string (`YYYY-MM-DD`). Returns the original
 * string if valid, `null` otherwise. We do not attempt to parse or
 * reformat — the DB `date` column expects this exact format.
 */
function normalizeIsoDate(value: string | null | undefined): string | null {
  const trimmed = trimOrNull(value);
  if (trimmed === null) {
    return null;
  }
  // Strict YYYY-MM-DD check
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }
  // Validate it parses to a real date
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  // Cross-check that the parsed date matches the input (catches e.g. 2024-02-30)
  const isoStr = parsed.toISOString().slice(0, 10);
  if (isoStr !== trimmed) {
    return null;
  }
  return trimmed;
}

/* ---------- Identity extraction ---------- */

/**
 * Extracted identity fields, ready to be written to the `customers`
 * table. Every field is nullable — a `null` means Didit did not provide
 * the field or the value failed normalization.
 */
export interface ExtractedIdentityData {
  readonly fullName: string | null;
  readonly dateOfBirth: string | null;
  readonly nationality: string | null;
  readonly documentType: string | null;
  readonly documentCountry: string | null;
}

/**
 * Extract identity fields from a KYC (phase 1) decision payload.
 *
 * `fullName` is derived from `firstName + lastName`. `nationality` maps
 * to `issuingCountry` — Didit's KYC workflow returns the document's
 * issuing country as the best proxy for nationality. `documentCountry`
 * also maps to `issuingCountry` for the same reason.
 */
export function extractIdentityData(decision: DiditDecisionPayload): ExtractedIdentityData {
  const kyc = decision.kyc;
  if (kyc === null || kyc === undefined) {
    return Object.freeze({
      fullName: null,
      dateOfBirth: null,
      nationality: null,
      documentType: null,
      documentCountry: null,
    });
  }

  const firstName = trimOrNull(kyc.firstName);
  const lastName = trimOrNull(kyc.lastName);

  // Build full name from parts, handling cases where one or both are null
  let fullName: string | null = null;
  if (firstName !== null && lastName !== null) {
    fullName = `${firstName} ${lastName}`;
  } else if (firstName !== null) {
    fullName = firstName;
  } else if (lastName !== null) {
    fullName = lastName;
  }

  const dateOfBirth = normalizeIsoDate(kyc.dateOfBirth);
  const nationality = normalizeCountryCode(kyc.issuingCountry);
  const documentType = trimOrNull(kyc.documentType);
  const documentCountry = normalizeCountryCode(kyc.issuingCountry);

  return Object.freeze({
    fullName,
    dateOfBirth,
    nationality,
    documentType,
    documentCountry,
  });
}

/* ---------- Address extraction ---------- */

/**
 * Extracted address fields, ready to be written to the `customers`
 * table. Every field is nullable.
 */
export interface ExtractedAddressData {
  readonly addressLine: string | null;
  readonly addressCity: string | null;
  readonly addressCountry: string | null;
}

/**
 * Extract address fields from an address (phase 2) decision payload.
 *
 * Didit's address/PoA workflow returns limited structured data: primarily
 * the country and whether the address was verified. The `addressLine`
 * and `addressCity` fields are not populated by Didit's address block
 * directly — they are returned as `null` here. If Didit extends the
 * address block with street/city in the future, this function should be
 * updated.
 *
 * `addressCountry` is derived from the address block's `country` field.
 */
export function extractAddressData(decision: DiditDecisionPayload): ExtractedAddressData {
  const address = decision.address;
  if (address === null || address === undefined) {
    return Object.freeze({
      addressLine: null,
      addressCity: null,
      addressCountry: null,
    });
  }

  const addressCountry = normalizeCountryCode(address.country);

  return Object.freeze({
    addressLine: null, // Didit PoA block does not provide structured address line
    addressCity: null, // Didit PoA block does not provide city
    addressCountry,
  });
}
