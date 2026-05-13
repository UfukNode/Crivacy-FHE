/**
 * Customer KYC level → score / display mapping.
 *
 * The `CustomerKycLevel` union and the level array live in
 * {@link ../kyc/phase-registry} (the SoT introduced in Sprint 9).
 * This module only owns the score / name lookup tables — adding a
 * new level means: (1) update the union in phase-registry, (2) add
 * the new key here (TS will fail the build until both are in sync).
 *
 * @module
 */

import {
  CUSTOMER_KYC_LEVELS,
  type CustomerKycLevel,
} from '@/lib/kyc/phase-registry';

export type { CustomerKycLevel };

export const LEVEL_SCORE_MAP: Readonly<Record<CustomerKycLevel, number>> = {
  kyc_0: 0,
  kyc_1: 100,
  kyc_2: 350,
  kyc_3: 550,
  kyc_4: 1000,
};

export const LEVEL_NAMES: Readonly<Record<CustomerKycLevel, string>> = {
  kyc_0: 'Unverified',
  kyc_1: 'Registered',
  kyc_2: 'Identity',
  kyc_3: 'Biometric',
  kyc_4: 'Enhanced',
};

export const MAX_SCORE = 1000;

/**
 * Compute the KYC score for a given level.
 */
export function computeKycScore(level: CustomerKycLevel): number {
  return LEVEL_SCORE_MAP[level];
}

/**
 * Get the human-readable name for a KYC level.
 */
export function kycLevelName(level: CustomerKycLevel): string {
  return LEVEL_NAMES[level];
}

/**
 * Get the next level above the current one, or null if at max.
 * Iteration order driven by the canonical level array in the
 * registry, so adding a new level only touches one file.
 */
export function nextKycLevel(level: CustomerKycLevel): CustomerKycLevel | null {
  const idx = CUSTOMER_KYC_LEVELS.indexOf(level);
  if (idx === -1 || idx >= CUSTOMER_KYC_LEVELS.length - 1) return null;
  return CUSTOMER_KYC_LEVELS[idx + 1]!;
}
