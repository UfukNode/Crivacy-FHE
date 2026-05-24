/**
 * DELETE /api/customer/oauth-consents/:id, revoke a specific
 * consent. Cascades into every access token minted against it;
 * future authorize calls for the same client+scope hit the form
 * again instead of the fast path.
 */

import { z } from 'zod';

import { customerActor } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { getAuthConfig } from '@/lib/auth/config';
import { lookupCustomer, lookupCustomerSession } from '@/lib/customer/lookup';
import { oauthClients, oauthConsents } from '@/lib/db/schema';
import { dispatchOauthConsentEvent } from '@/lib/oauth';
import { customerRoute } from '@/server/middleware/customer-route';
import { revokeConsent } from '@/server/repositories';
import { and, eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IdSchema = z.object({ id: z.string().uuid() });

export const DELETE = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  handler: async (ctx) => {
    const url = new URL(ctx.request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const raw = segments[segments.length - 1] ?? '';
    const { id } = IdSchema.parse({ id: raw });

    // Validate the consent belongs to this customer before revoking
    //, the repo helper doesn't scope by user, so we do the check
    // here to keep cross-user revokes impossible.
    const rows = await ctx.db
      .select()
      .from(oauthConsents)
      .where(and(eq(oauthConsents.id, id), eq(oauthConsents.userId, ctx.customer.id)))
      .limit(1);
    const consent = rows[0];
    if (consent === undefined) {
      return ctx.errorJson('not_found', 'Consent not found.', 404);
    }
    if (consent.revokedAt !== null) {
      return ctx.errorJson('conflict', 'This consent is already revoked.', 409);
    }

    // Load the client so we have firm_id + public client_id for
    // the audit meta and the webhook fan-out. We already know the
    // client uuid from the consent row. A revoked client row is
    // still a valid lookup target here, a firm whose app has
    // been retired should still receive (or at least have the
    // event recorded for) user-initiated revocations.
    const clientRows = await ctx.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, consent.clientId))
      .limit(1);
    const clientRow = clientRows[0];
    if (clientRow === undefined) {
      return ctx.errorJson('not_found', 'Associated client not found.', 404);
    }

    await revokeConsent(ctx.db, id, ctx.now, 'user_revoked');

    await writeAudit(ctx.db, {
      action: 'oauth_consent.revoked',
      // AUD-X-AUDIT-001 fix: this is a CUSTOMER-initiated revoke, so
      // actor kind must be `customer` for audit queries like
      // `WHERE actor_kind = 'customer'` to surface it correctly.
      // `firmId` is kept in meta for downstream consent-per-firm
      // dashboards.
      actor: customerActor({
        id: ctx.customer.id,
        label: ctx.customer.email ?? ctx.customer.id,
      }),
      target: uuidTarget({ kind: 'oauth_consent', id }),
      context: buildAuditRequestContext({
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      }),
      meta: {
        firmId: clientRow.firmId,
        clientId: clientRow.clientId,
        clientUuid: clientRow.id,
        reason: 'user_revoked',
      },
      ts: ctx.now,
    });

    await dispatchOauthConsentEvent(ctx.db, 'oauth.consent.revoked', {
      firmId: clientRow.firmId,
      clientId: clientRow.clientId,
      clientUuid: clientRow.id,
      userId: ctx.customer.id,
      consentId: id,
      scope: consent.scope,
      revokedAt: ctx.now,
      reason: 'user_revoked',
    });

    return ctx.noContent();
  },
});
