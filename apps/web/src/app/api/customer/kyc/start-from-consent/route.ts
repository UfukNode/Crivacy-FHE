/**
 * POST /api/customer/kyc/start-from-consent
 *
 * OAuth-consent fast path. The consent screen's "Start verification"
 * button calls here instead of bouncing the user through the `/kyc`
 * dashboard: one click, one redirect to Didit, the dashboard detour
 * is skipped entirely. Matches the Stripe / Persona / Onfido pattern
 * where the consent host hands the user straight to the verification
 * provider.
 *
 * Security envelope (every defence re-runs server-side because the
 * client could lie about any of it):
 *
 *   1. Customer session (via `customerRoute` middleware).
 *   2. Per-customer rate limit (`kyc_start`, 5/min), shields the
 *      billable Didit session creation from clicks + replay.
 *   3. Authorization request must be alive, not completed, not
 *      expired, not from a different firm, otherwise the user
 *      would start a KYC flow for a request that is already dead.
 *   4. KYC gate must actually require work. If the customer's
 *      credential already covers the requested scopes (the gate
 *      closed between bootstrap and this call), we bounce them back
 *      to the consent screen instead of creating a pointless Didit
 *      session. Happens in practice when two tabs race or when the
 *      user completes KYC in another window.
 *   5. Choose the correct Didit entry point (identity vs address)
 *      from the current credential state.
 *
 * Returns `{ redirectUrl }` on success; the client does the
 * `window.location.assign`. Errors are standard JSON with a
 * specific `code` so the consent page can surface a humanized
 * message.
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { oauthClients } from '@/lib/db/schema';
import {
  OauthError,
  maxRequiredLevel,
  parseScope,
  rankKycLevel,
} from '@/lib/oauth';
import {
  type CustomerKycLevel,
  nextDiditPhase,
} from '@/lib/kyc/phase-registry';
import { lookupCustomer, lookupCustomerSession } from '@/lib/customer/lookup';
import {
  handleStartAddress,
  handleStartIdentity,
} from '@/server/handlers/customer-kyc';
import {
  ensureAuthRequestOwnership,
  findActiveCredentialForUser,
} from '@/server/handlers/oauth-shared';
import { customerRoute } from '@/server/middleware/customer-route';
import { parseBody } from '@/server/middleware/parse';
import { findAuthorizationRequest } from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  requestId: z.string().min(1).max(128),
});

export const POST = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
  handler: async (ctx) => {
    // --- Rate limit -----------------------------------------------
    const limited = await maybeRateLimitResponse(
      ctx.db,
      'kyc_start',
      ctx.customer.id,
      ctx.now,
    );
    if (limited !== null) return limited;

    const { requestId } = await parseBody(ctx.request, Body);

    // --- Authorization request must be alive ----------------------
    const authRequest = await findAuthorizationRequest(ctx.db, requestId);
    if (authRequest === null) {
      return ctx.errorJson('not_found', 'Authorization request not found.', 404);
    }
    if (authRequest.completedAt !== null) {
      return ctx.errorJson(
        'conflict',
        'This authorization request has already been completed.',
        409,
      );
    }
    if (authRequest.expiresAt.getTime() <= ctx.now.getTime()) {
      return ctx.errorJson('conflict', 'Authorization request has expired.', 410);
    }

    // --- Ownership gate --------------------------------------------
    // The KYC session we're about to create is billable upstream
    // and permanently tied to the calling customer. Refuse to spin
    // one up on behalf of a request that belongs to a different
    // user. Matches the consent bootstrap + submit guardrails.
    const ownership = await ensureAuthRequestOwnership(
      ctx.db,
      authRequest,
      ctx.customer.id,
    );
    if (!ownership.ok) {
      return ctx.errorJson(
        'owner_mismatch',
        'This authorization request belongs to a different user.',
        403,
      );
    }

    // --- Parse scopes + load client (for ownership sanity) --------
    const clientRows = await ctx.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, authRequest.clientId))
      .limit(1);
    if (clientRows[0] === undefined) {
      return ctx.errorJson('not_found', 'OAuth client is no longer active.', 404);
    }

    let parsedScopes;
    try {
      parsedScopes = parseScope(authRequest.scope);
    } catch (err) {
      if (err instanceof OauthError) {
        return ctx.errorJson('validation_failed', err.message, 400);
      }
      throw err;
    }

    // --- Re-check KYC gate server-side ----------------------------
    // The client cannot be trusted to tell us the current level,
    // so we derive it from the user's active credential right now.
    const credential = await findActiveCredentialForUser(ctx.db, ctx.customer.id, ctx.now);
    const neededLevel = maxRequiredLevel(parsedScopes);
    const neededRank = rankKycLevel(neededLevel);
    const currentRank = credential === null ? -1 : rankKycLevel(credential.level);

    if (neededRank < 0 || currentRank >= neededRank) {
      // Already covered, the consent screen will render the Approve
      // branch on reload. Hand the client a path back to it.
      return ctx.json({
        redirectUrl: `/oauth/consent?request=${encodeURIComponent(requestId)}`,
      });
    }

    // --- Pick the right Didit entry point --------------------------
    //
    // Sprint 9: replaced the hand-rolled `needsAddressOnly`
    // derivation with `nextDiditPhase(level)` from the phase
    // registry. Both surfaces (this OAuth fast path AND the /kyc
    // dashboard's natural progression) now ask the same registry
    // question, there's no second copy of the entry-point logic
    // for a future phase to drift away from.
    //
    // Mapping `credential` (oauth-domain `'basic' | 'enhanced'`) to
    // `CustomerKycLevel` (DB-domain `'kyc_0'` … `'kyc_4'`):
    //
    //   * `null`     → kyc_0 (no credential issued, identity needed)
    //   * `basic`    → kyc_3 (Basic on-chain, address still missing)
    //   * `enhanced` → kyc_4 (fully verified, no Didit phase left)
    //
    // The registry entry-point selector returns `null` for kyc_4
    // (which would mean the gate is already covered, caught above
    // by the `currentRank >= neededRank` branch but defended here
    // too in case a level rolls over without the gate check).
    const customerLevel: CustomerKycLevel =
      credential === null
        ? 'kyc_0'
        : credential.level === 'enhanced'
          ? 'kyc_4'
          : 'kyc_3';
    const phase = nextDiditPhase(customerLevel);
    if (phase === null) {
      // No Didit phase remaining, gate must already be covered.
      // Bounce back to consent so the Approve branch lights up.
      return ctx.json({
        redirectUrl: `/oauth/consent?request=${encodeURIComponent(requestId)}`,
      });
    }

    // Delegate to the start handler the registry pointed at —
    // inherits all of its protections (status check, eligibility,
    // session-resume, audit, partial-unique-index). The OAuth
    // route just decided WHICH one to call.
    //
    // Sprint 9 `continueUrl` threading: persist the consent return
    // path on the new session row so `/kyc/callback` can land the
    // user back at the partner's authorize flow once the verdict
    // arrives, the SSE listener on `/oauth/consent` is still the
    // primary signal, but the callback page's redirect is the
    // explicit happy-path.
    const continueUrl = `/oauth/consent?request=${encodeURIComponent(requestId)}`;
    if (phase.id === 'address') {
      return handleStartAddress(ctx, continueUrl);
    }
    if (phase.id === 'identity') {
      return handleStartIdentity(ctx, continueUrl);
    }
    // `nft_mint` has no Didit-driven start handler; treated as
    // already-covered for consent purposes (mint is post-OAuth).
    return ctx.json({
      redirectUrl: `/oauth/consent?request=${encodeURIComponent(requestId)}`,
    });
  },
});
