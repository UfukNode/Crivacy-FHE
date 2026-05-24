/**
 * GET /api/customer/oauth-consents, list the firms this customer
 * has approved via OAuth, so the "Connected apps" page can render
 * them. Includes revoked rows so the UI can show history if wanted
 * (toggled via ?includeRevoked=true).
 */

import { and, eq, inArray } from 'drizzle-orm';

import { getAuthConfig } from '@/lib/auth/config';
import { lookupCustomer, lookupCustomerSession } from '@/lib/customer/lookup';
import { oauthClients, oauthConsents } from '@/lib/db/schema';
import { customerRoute } from '@/server/middleware/customer-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  handler: async (ctx) => {
    const consents = await ctx.db
      .select()
      .from(oauthConsents)
      .where(eq(oauthConsents.userId, ctx.customer.id));

    if (consents.length === 0) {
      return ctx.json({ data: [], pagination: { nextCursor: null, limit: 0 } });
    }

    // Load matching clients in a single roundtrip.
    const clientIds = Array.from(new Set(consents.map((c) => c.clientId)));
    const clients = await ctx.db
      .select()
      .from(oauthClients)
      .where(inArray(oauthClients.id, clientIds));
    const clientMap = new Map(clients.map((c) => [c.id, c]));

    const now = ctx.now.getTime();
    const data = consents
      .map((consent) => {
        const client = clientMap.get(consent.clientId);
        if (client === undefined) return null;
        const isActive = consent.revokedAt === null && consent.expiresAt.getTime() > now;
        return {
          id: consent.id,
          clientId: client.clientId,
          clientName: client.name,
          clientDescription: client.description,
          clientLogoUrl: client.logoUrl,
          clientHomepageUrl: client.homepageUrl,
          scope: consent.scope,
          scopes: consent.scope.split(' ').filter((s) => s.length > 0),
          grantedAt: consent.grantedAt.toISOString(),
          expiresAt: consent.expiresAt.toISOString(),
          lastUsedAt: consent.lastUsedAt !== null ? consent.lastUsedAt.toISOString() : null,
          revokedAt: consent.revokedAt !== null ? consent.revokedAt.toISOString() : null,
          isActive,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => {
        // Active first, then by granted_at desc.
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return b.grantedAt.localeCompare(a.grantedAt);
      });

    return ctx.json({ data, pagination: { nextCursor: null, limit: data.length } });
  },
});

// Silence the unused helper, kept for when we add filters later.
void and;
