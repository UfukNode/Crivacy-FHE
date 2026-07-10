/**
 * POST /api/internal/firm/wallet/challenge
 *
 * Issue a SIWE (EIP-4361) nonce so a firm can prove control of the EVM address
 * it wants Crivacy to target with the per-user `grantAccess`. Mirrors the
 * customer wallet-challenge flow, but gated on a firm dashboard session.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { generateWalletChallenge } from '@/lib/customer/evm-wallet';
import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { dashboardRoute } from '@/server/middleware';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = dashboardRoute({
  permission: 'firm.update',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    // Per-IP cap — a stolen firm-admin session could otherwise mint
    // unbounded challenges to probe the signing endpoint.
    const limited = await maybeRateLimitResponse(ctx.db, 'firm_wallet_challenge', ctx.ip, ctx.now);
    if (limited) return limited;

    const { challengeJwt, nonce } = await generateWalletChallenge(getAuthConfig().jwtSecret);
    return ctx.json({ challenge: challengeJwt, nonce });
  },
});
