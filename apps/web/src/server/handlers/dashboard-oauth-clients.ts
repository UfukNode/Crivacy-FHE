/**
 * Dashboard OAuth client management.
 *
 * Counterpart to `/dashboard/oauth-clients`. Firms register
 * one or more OAuth clients here, each with its own set of redirect
 * URIs and scope ceiling. Create / rotate / revoke all flow through
 * this handler so the audit trail has a single call site.
 *
 * The raw `client_secret` is returned exactly once — on create and
 * on rotate. All other reads return the masked placeholder from the
 * summary DTO.
 *
 * @module
 */

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { firmUserActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { acquireFirmResourceLock } from '@/lib/db/advisory-lock';
import {
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  type OauthClient,
} from '@/lib/db/schema';
import {
  KNOWN_SCOPE_IDS,
  expandImplicitScopes,
  generateClientId,
  generateClientSecret,
  hashClientSecret,
  type ClientMode,
  type OauthScopeId,
} from '@/lib/oauth';
import type { DashboardContext } from '../context';
import { DEFAULT_TIER_LIMITS } from '@/lib/ratelimit/tiers';
import {
  countOauthClientsByFirm,
  findOauthClientById,
  insertOauthClient,
  listOauthClientsForFirm,
} from '../repositories';

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/**
 * Dashboard-facing view of an OAuth client. The `clientSecret`
 * placeholder mirrors the api-key masked-value pattern — firms see
 * "hidden" in every read after create/rotate.
 */
export interface OauthClientSummary {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly description: string | null;
  readonly logoUrl: string | null;
  readonly homepageUrl: string | null;
  readonly redirectUris: readonly string[];
  readonly allowedScopes: readonly string[];
  readonly isPublicClient: boolean;
  readonly consentTtlDays: number;
  readonly secretMasked: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

function toSummary(row: OauthClient): OauthClientSummary {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    description: row.description,
    logoUrl: row.logoUrl,
    homepageUrl: row.homepageUrl,
    redirectUris: row.redirectUris,
    allowedScopes: row.allowedScopes,
    isPublicClient: row.isPublicClient,
    consentTtlDays: row.consentTtlDays,
    // Neutral bullet mask — the list UI pairs this with its own
    // "client_secret" label above the field, so prefixing the mask
    // with the word again produced "client_secret client_secret•••"
    // double-naming in the rendered card. The new renderer treats
    // this as the placeholder value only.
    secretMasked: row.clientSecretHash !== null ? '••••••••••••••••••••••••' : 'public client (no secret)',
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt !== null ? row.revokedAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const redirectUriSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'redirect_uri must be a valid http(s) URL.');

/**
 * Web-visible URLs a firm submits for its consent-screen branding
 * (logo, homepage). These land in `<img src>` and `<a href>` on
 * pages that end-users visit, so we reject any scheme that could
 * execute script or fetch attacker-controlled data: `javascript:`,
 * `data:`, `blob:`, `file:`, `vbscript:`. Zod's built-in `.url()`
 * happily accepts those — the extra `.refine()` pins the scheme
 * whitelist.
 *
 * `http:` is excluded deliberately: consent-screen assets are
 * third-party embeds rendered in our origin, and a plaintext
 * asset would trigger mixed-content blocks anyway.
 */
const httpsWebUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Must be an https:// URL.');

const scopeEnum = z.enum(KNOWN_SCOPE_IDS as readonly [OauthScopeId, ...OauthScopeId[]]);

/**
 * Creation payload. `mode` drives the `client_id` prefix and has no
 * other runtime effect today — it's carried for observability and for
 * the live/test filter in the UI.
 */
export const OauthClientCreateSchema = z.object({
  name: z.string().min(1).max(128).trim(),
  description: z.string().max(2000).optional(),
  logoUrl: httpsWebUrlSchema.optional(),
  homepageUrl: httpsWebUrlSchema.optional(),
  redirectUris: z.array(redirectUriSchema).min(1).max(20),
  allowedScopes: z.array(scopeEnum).min(1).max(16),
  isPublicClient: z.boolean().default(false),
  mode: z.enum(['live', 'test']).default('test'),
  consentTtlDays: z.number().int().min(1).max(90).default(90),
});
export type OauthClientCreateInput = z.infer<typeof OauthClientCreateSchema>;

export const OauthClientUpdateSchema = z.object({
  name: z.string().min(1).max(128).trim().optional(),
  description: z.string().max(2000).nullable().optional(),
  logoUrl: httpsWebUrlSchema.nullable().optional(),
  homepageUrl: httpsWebUrlSchema.nullable().optional(),
  redirectUris: z.array(redirectUriSchema).min(1).max(20).optional(),
  allowedScopes: z.array(scopeEnum).min(1).max(16).optional(),
  consentTtlDays: z.number().int().min(1).max(90).optional(),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleDashboardListOauthClients(
  ctx: DashboardContext,
): Promise<readonly OauthClientSummary[]> {
  const rows = await listOauthClientsForFirm(ctx.db, ctx.firm.id);
  return rows.map(toSummary);
}

export interface OauthClientCreationResult {
  readonly summary: OauthClientSummary;
  /** Raw secret returned once. `null` for public clients. */
  readonly clientSecret: string | null;
}

/**
 * Same tier-capacity shape the webhook handler uses, kept as a
 * distinct union so the route can translate each outcome to its
 * own HTTP status + message without guessing.
 */
export type OauthClientCreationOutcome =
  | { readonly status: 'created'; readonly summary: OauthClientSummary; readonly clientSecret: string | null }
  | {
      readonly status: 'tier_exceeded';
      readonly tier: string;
      readonly maxSlots: number;
    };

export async function handleDashboardCreateOauthClient(
  ctx: DashboardContext,
  input: OauthClientCreateInput,
): Promise<OauthClientCreationOutcome> {
  const tier = ctx.firm.tier as keyof typeof DEFAULT_TIER_LIMITS;
  const tierLimits = DEFAULT_TIER_LIMITS[tier];
  const capSlots =
    tierLimits !== undefined && tierLimits.oauthClients !== null
      ? tierLimits.oauthClients
      : null;

  const clientId = generateClientId(input.mode as ClientMode);

  let rawSecret: string | null = null;
  let secretHash: string | null = null;
  if (!input.isPublicClient) {
    rawSecret = generateClientSecret();
    secretHash = await hashClientSecret(rawSecret);
  }

  // Normalise the scope set before it hits the DB. The dashboard UI
  // auto-bundles `credential` with every other `kyc*` scope so firms
  // can verify the credential on-chain, but a crafted request (via
  // curl / a tampered fetch) could sidestep the form lock and ship
  // a client whose `allowedScopes` omits the chain companion. The
  // authorize endpoint would then reject every request — an ugly,
  // silent failure mode. Expanding here guarantees the stored scope
  // set matches what `expandImplicitScopes` produces at parse time.
  const normalisedScopes = [
    ...expandImplicitScopes(input.allowedScopes as readonly OauthScopeId[]),
  ];

  // Lock + count + insert + audit inside one transaction.
  //
  // The per-firm advisory lock serialises two concurrent "Create
  // client" requests for the same firm: the second caller blocks
  // at `pg_advisory_xact_lock` until the first commits, then reads
  // the fresh post-insert count and bails with `tier_exceeded` if
  // it's now at the cap. Without the lock both callers observed
  // the pre-insert count, both decided they were under tier, and
  // both inserted — a race that bumped paying tiers one slot over
  // their ceiling. Revoked rows still count against the cap so a
  // rotate-through-the-ceiling trick doesn't reopen the gap.
  const outcome = await ctx.db.transaction(async (tx) => {
    await acquireFirmResourceLock(tx, ctx.firm.id, 'oauth_clients');

    if (capSlots !== null) {
      const existingCount = await countOauthClientsByFirm(tx, ctx.firm.id);
      if (existingCount >= capSlots) {
        return {
          status: 'tier_exceeded',
          tier: ctx.firm.tier,
          maxSlots: capSlots,
        } as const;
      }
    }

    const inserted = await insertOauthClient(tx, {
      firmId: ctx.firm.id,
      clientId,
      clientSecretHash: secretHash,
      name: input.name,
      description: input.description ?? null,
      logoUrl: input.logoUrl ?? null,
      homepageUrl: input.homepageUrl ?? null,
      redirectUris: input.redirectUris,
      allowedScopes: normalisedScopes,
      isPublicClient: input.isPublicClient,
      consentTtlDays: input.consentTtlDays,
      createdByFirmUserId: ctx.user.id,
    });

    await writeAudit(tx, {
      action: 'oauth_client.created',
      actor: firmUserActor({ id: ctx.user.id, firmId: ctx.firm.id, label: ctx.user.email }),
      target: uuidTarget({ kind: 'oauth_client', id: inserted.id }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        clientId,
        mode: input.mode,
        isPublicClient: input.isPublicClient,
        redirectUrisCount: input.redirectUris.length,
        scopes: normalisedScopes,
      },
      ts: ctx.now,
    });

    return { status: 'inserted', row: inserted } as const;
  });

  if (outcome.status === 'tier_exceeded') {
    return outcome;
  }
  return { status: 'created', summary: toSummary(outcome.row), clientSecret: rawSecret };
}

export async function handleDashboardGetOauthClient(
  ctx: DashboardContext,
  id: string,
): Promise<OauthClientSummary | null> {
  const row = await findOauthClientById(ctx.db, id, ctx.firm.id);
  if (row === null) return null;
  return toSummary(row);
}

/**
 * Rotate the client_secret. A firm uses this when an operator
 * leaves or a compromise is suspected. The old hash is overwritten
 * in place — existing access tokens keep working because they are
 * independent of client_secret (revoke those via `/revoke` or by
 * deleting the consent).
 */
export async function handleDashboardRotateOauthClientSecret(
  ctx: DashboardContext,
  id: string,
): Promise<{ clientSecret: string; summary: OauthClientSummary } | null> {
  const existing = await findOauthClientById(ctx.db, id, ctx.firm.id);
  if (existing === null) return null;
  if (existing.isPublicClient) {
    throw new Error('Cannot rotate secret on a public client.');
  }

  const raw = generateClientSecret();
  const hash = await hashClientSecret(raw);

  const [updated] = await ctx.db
    .update(oauthClients)
    .set({ clientSecretHash: hash, updatedAt: ctx.now })
    .where(eq(oauthClients.id, id))
    .returning();
  if (updated === undefined) return null;

  await writeAudit(ctx.db, {
    action: 'oauth_client.secret_rotated',
    actor: firmUserActor({ id: ctx.user.id, firmId: ctx.firm.id, label: ctx.user.email }),
    target: uuidTarget({ kind: 'oauth_client', id }),
    context: buildAuditRequestContext({
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId,
    }),
    meta: { clientId: existing.clientId },
    ts: ctx.now,
  });

  return { clientSecret: raw, summary: toSummary(updated) };
}

export async function handleDashboardUpdateOauthClient(
  ctx: DashboardContext,
  id: string,
  input: z.infer<typeof OauthClientUpdateSchema>,
): Promise<OauthClientSummary | null> {
  const existing = await findOauthClientById(ctx.db, id, ctx.firm.id);
  if (existing === null) return null;

  const updates: Record<string, unknown> = { updatedAt: ctx.now };
  if (input.name !== undefined) updates['name'] = input.name;
  if (input.description !== undefined) updates['description'] = input.description;
  if (input.logoUrl !== undefined) updates['logoUrl'] = input.logoUrl;
  if (input.homepageUrl !== undefined) updates['homepageUrl'] = input.homepageUrl;
  if (input.redirectUris !== undefined) updates['redirectUris'] = input.redirectUris;
  if (input.allowedScopes !== undefined) {
    // Same normalisation as create — prevents a crafted PATCH from
    // stripping `credential` while keeping other kyc scopes, which
    // would leave the client stored in an inconsistent state that
    // the authorize endpoint would reject at runtime.
    updates['allowedScopes'] = [
      ...expandImplicitScopes(input.allowedScopes as readonly OauthScopeId[]),
    ];
  }
  if (input.consentTtlDays !== undefined) updates['consentTtlDays'] = input.consentTtlDays;

  // Update + audit inside one transaction.
  //
  // Without the transaction, an audit-writer failure after the
  // UPDATE commits would leave the client row mutated but with
  // no audit record of who changed what. Compliance relies on a
  // 1:1 match between `oauth_client.updated` audit rows and
  // committed mutations — wrapping both writes in a TX keeps
  // that invariant: either both land or neither does. Matches
  // the pattern already used by consent submit and client
  // create/revoke in this file.
  return ctx.db.transaction(async (tx) => {
    // AUD-INT-AUTHZ-IDOR-002 fix: defence-in-depth — UPDATE's WHERE
    // must repeat the firm scope. The SELECT pre-check above already
    // confirmed ownership, but hardcoding the firm filter on every
    // mutation is the canonical pattern in the rest of this file
    // (see `handleDashboardRevokeOauthClient` → `and(eq(id), eq(firmId))`)
    // and what the rest of the repos do. If cross-firm transfer is
    // ever added, the invariant stays safe without a source hunt.
    const [updated] = await tx
      .update(oauthClients)
      .set(updates as Partial<typeof oauthClients.$inferInsert>)
      .where(and(eq(oauthClients.id, id), eq(oauthClients.firmId, ctx.firm.id)))
      .returning();
    if (updated === undefined) return null;

    await writeAudit(tx, {
      action: 'oauth_client.updated',
      actor: firmUserActor({ id: ctx.user.id, firmId: ctx.firm.id, label: ctx.user.email }),
      target: uuidTarget({ kind: 'oauth_client', id }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        clientId: existing.clientId,
        fields: Object.keys(updates).filter((k) => k !== 'updatedAt'),
      },
      ts: ctx.now,
    });

    return toSummary(updated);
  });
}

/**
 * Soft-revoke the client. Stamps `revoked_at` on the client row
 * AND cascade-kills every outstanding access token it minted AND
 * every outstanding consent row for it. The access-token cascade
 * closes the gap where a leaked token kept answering `/userinfo`
 * until its 60-minute TTL expired even though the firm admin had
 * already pressed "revoke". The consent cascade closes the UX
 * companion: customers looking at `/settings/connected-apps`
 * would otherwise see an `isActive=true` row (consent.revokedAt
 * null, expiresAt in the future) for a firm whose client has
 * been killed server-side, producing a "why does this still say
 * connected?" question. Cascading the consent row makes
 * `isActive` flip to `false` on the next page load and drops it
 * out of the "active connections" section.
 *
 * Revoke reason is `client_revoked` on both cascades so audit
 * query can correlate them with the parent `oauth_client.revoked`
 * row. The `/userinfo` query also joins on the client's
 * `revoked_at` so a stale token becomes unusable the instant the
 * client is revoked, even before either cascade finishes
 * rewriting downstream rows.
 */
/**
 * Revoke result discriminates three cases so the caller can tell
 * apart "not mine / doesn't exist" (404), "fresh revoke" (204), and
 * "already revoked" (204 idempotent). The earlier signature returned
 * a bare boolean and the route treated `false` as 404 — which led to
 * confusing UX where a second revoke on the same row surfaced as
 * "OAuth client not found or already revoked" even though the
 * desired end state was already in place.
 */
export type RevokeOauthClientResult = 'revoked' | 'already_revoked' | 'not_found';

export async function handleDashboardRevokeOauthClient(
  ctx: DashboardContext,
  id: string,
): Promise<RevokeOauthClientResult> {
  return ctx.db.transaction(async (tx) => {
    // Look up first so we can distinguish "row doesn't exist / not
    // mine" (genuine 404) from "already revoked" (idempotent ack).
    const existing = await findOauthClientById(tx, id, ctx.firm.id);
    if (existing === null) return 'not_found';
    if (existing.revokedAt !== null) return 'already_revoked';

    await tx
      .update(oauthClients)
      .set({ revokedAt: ctx.now, updatedAt: ctx.now })
      .where(and(eq(oauthClients.id, id), eq(oauthClients.firmId, ctx.firm.id)));

    // Cascade-revoke every access token the client ever minted. The
    // `/userinfo` DB lookup already filters via an inner join on
    // the client's `revoked_at`, so this cascade is defence-in-
    // depth: it keeps the audit trail consistent ("tokens revoked
    // at the same tick as the client", one tidy row per kill) and
    // the dashboard's active-token counter drops to zero on the
    // first refresh. Scoped to this `clientId` so no other firm's
    // data is touched.
    await tx
      .update(oauthAccessTokens)
      .set({ revokedAt: ctx.now, revokedReason: 'client_revoked' })
      .where(
        and(
          eq(oauthAccessTokens.clientId, id),
          isNull(oauthAccessTokens.revokedAt),
        ),
      );

    // Cascade-revoke every active consent row for this client.
    // Without this, `/settings/connected-apps` kept showing the
    // firm as an `isActive=true` grant because the consent row's
    // `revoked_at` was still NULL — a customer-facing lie given
    // the client itself is now dead. Scoped to this `clientId`
    // and `revoked_at IS NULL` so a prior user-initiated revoke
    // keeps its original reason (we do NOT overwrite an existing
    // `user_revoked` row with `client_revoked`).
    await tx
      .update(oauthConsents)
      .set({ revokedAt: ctx.now, revokedReason: 'client_revoked' })
      .where(
        and(
          eq(oauthConsents.clientId, id),
          isNull(oauthConsents.revokedAt),
        ),
      );

    await writeAudit(tx, {
      action: 'oauth_client.revoked',
      actor: firmUserActor({ id: ctx.user.id, firmId: ctx.firm.id, label: ctx.user.email }),
      target: uuidTarget({ kind: 'oauth_client', id }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {},
      ts: ctx.now,
    });

    return 'revoked';
  });
}
