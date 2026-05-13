/**
 * Firm-user TOTP management — thin adapter over the audience-agnostic
 * primitives in `lib/auth/totp-management.ts`.
 *
 * This file used to hold the full implementation. It now exists only
 * to preserve the existing public API (which takes `firmUserId` rather
 * than the generic `userId`) so migration to the new primitives can
 * happen incrementally — every old caller keeps compiling while Phase 3
 * endpoint migration converts them over one at a time.
 *
 * New callers should import directly from `@/lib/auth/totp-management`
 * and pass `FIRM_TOTP_TABLE`.
 *
 * @module
 */

import type { AuthConfig } from '@/lib/auth/config';
import type { CrivacyDatabase } from '@/lib/db/client';
import {
  FIRM_TOTP_TABLE,
  countRemainingRecoveryCodes as countRemainingRecoveryCodesGeneric,
  disableTotp as disableTotpGeneric,
  regenerateRecoveryCodes as regenerateRecoveryCodesGeneric,
  replaceTotp as replaceTotpGeneric,
  type RegenerateRecoveryCodesResult,
  type ReplaceTotpResult,
} from '@/lib/auth/totp-management';

export type { RegenerateRecoveryCodesResult, ReplaceTotpResult };

export interface ReplaceTotpInput {
  readonly db: CrivacyDatabase;
  readonly authConfig: AuthConfig;
  readonly firmUserId: string;
  readonly newSecret: string;
  readonly newTotpCode: string;
  readonly now: Date;
}

export function replaceTotp(input: ReplaceTotpInput): Promise<ReplaceTotpResult> {
  return replaceTotpGeneric({
    db: input.db,
    authConfig: input.authConfig,
    table: FIRM_TOTP_TABLE,
    userId: input.firmUserId,
    newSecret: input.newSecret,
    newTotpCode: input.newTotpCode,
    now: input.now,
  });
}

export interface DisableTotpInput {
  readonly db: CrivacyDatabase;
  readonly firmUserId: string;
  readonly now: Date;
}

export function disableTotp(input: DisableTotpInput): Promise<void> {
  return disableTotpGeneric({
    db: input.db,
    table: FIRM_TOTP_TABLE,
    userId: input.firmUserId,
    now: input.now,
  });
}

export interface RegenerateRecoveryCodesInput {
  readonly db: CrivacyDatabase;
  readonly firmUserId: string;
  readonly now: Date;
}

export function regenerateRecoveryCodes(
  input: RegenerateRecoveryCodesInput,
): Promise<RegenerateRecoveryCodesResult> {
  return regenerateRecoveryCodesGeneric({
    db: input.db,
    table: FIRM_TOTP_TABLE,
    userId: input.firmUserId,
    now: input.now,
  });
}

export function countRemainingRecoveryCodes(
  db: CrivacyDatabase,
  firmUserId: string,
): Promise<number> {
  return countRemainingRecoveryCodesGeneric(db, FIRM_TOTP_TABLE, firmUserId);
}
