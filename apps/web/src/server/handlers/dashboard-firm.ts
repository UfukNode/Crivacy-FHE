/**
 * Dashboard firm profile handlers — get + update.
 *
 * @module
 */

import { firmUserActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';

import type { DashboardContext } from '../context';

/* ---------- Types ---------- */

export interface FirmProfileRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly tier: string;
  readonly contactEmail: string | null;
  readonly countryCode: string | null;
  readonly billingEmail: string | null;
  readonly supportUrl: string | null;
  readonly createdAt: Date;
}

export interface FirmSettingsRow {
  readonly totpRequired: boolean;
  readonly dataRetentionDays: number;
  readonly ipAllowlist: readonly string[] | null;
}

export interface FirmProfileResult {
  readonly firm: FirmProfileRow;
  readonly settings: FirmSettingsRow | null;
}

export interface UpdateFirmInput {
  readonly name?: string;
  readonly contactEmail?: string;
  readonly billingEmail?: string;
  readonly supportUrl?: string;
}

/* ---------- DI ---------- */

export interface FirmProfileDeps {
  readonly findFirmProfile: (ctx: DashboardContext) => Promise<FirmProfileRow | null>;
  readonly findFirmSettings: (ctx: DashboardContext) => Promise<FirmSettingsRow | null>;
  readonly updateFirm: (ctx: DashboardContext, updates: UpdateFirmInput) => Promise<FirmProfileRow>;
}

/* ---------- Handlers ---------- */

/**
 * Get the current firm's profile and settings.
 */
export async function handleGetFirmProfile(
  deps: FirmProfileDeps,
  ctx: DashboardContext,
): Promise<FirmProfileResult> {
  const firm = await deps.findFirmProfile(ctx);
  if (firm === null) {
    throw new Error('Firm not found');
  }
  const settings = await deps.findFirmSettings(ctx);
  return { firm, settings };
}

/**
 * Update the current firm's profile. Writes a `firm.updated` audit
 * entry attributed to the firm user, not an admin — this is
 * dashboard self-service, not admin panel action.
 */
export async function handleUpdateFirmProfile(
  deps: FirmProfileDeps,
  ctx: DashboardContext,
  input: UpdateFirmInput,
): Promise<FirmProfileRow> {
  const result = await deps.updateFirm(ctx, input);

  await writeAudit(ctx.db, {
    action: 'firm.updated',
    actor: firmUserActor({
      id: ctx.user.id,
      label: ctx.user.email,
      firmId: ctx.firm.id,
    }),
    target: uuidTarget({ kind: 'firm', id: ctx.firm.id }),
    context: buildAuditRequestContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    }),
    meta: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
      ...(input.billingEmail !== undefined ? { billingEmail: input.billingEmail } : {}),
      ...(input.supportUrl !== undefined ? { supportUrl: input.supportUrl } : {}),
      source: 'dashboard_self_update',
    },
    ts: ctx.now,
  });

  return result;
}
