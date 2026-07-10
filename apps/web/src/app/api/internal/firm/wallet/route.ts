/**
 * Firm on-chain wallet registration.
 *
 *   GET    /api/internal/firm/wallet   — read the firm's registered address
 *   PUT    /api/internal/firm/wallet   — prove control of an address (SIWE) + save
 *   DELETE /api/internal/firm/wallet   — disconnect (clear the address)
 *
 * The saved address is the target of the per-user gatekeeper
 * `grantAccess(user, firm, minLevel)`. Registration requires a SIWE signature,
 * so a firm can only bind an address it actually controls — the same address
 * whose key decrypts the eligibility verdict. Crivacy never holds that key.
 */

import { z } from 'zod';

import { getAuthConfig } from '@/lib/auth/config';
import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import {
  claimWalletNonce,
  verifyEvmWalletSignature,
  verifyWalletChallenge,
} from '@/lib/customer/evm-wallet';
import { dashboardRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
  getFirmOnchainAddress,
  setFirmOnchainAddress,
} from '@/server/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ConnectBody = z.object({
  challenge: z.string().min(1).max(4096),
  // The full EIP-4361 (SIWE) message the firm's wallet signed. Carries the
  // address, domain and nonce; the server recovers + verifies the address.
  message: z.string().min(1).max(4096),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'signature must be 0x-prefixed hex')
    .max(4096),
});

const sharedAuth = {
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
} as const;

export const GET = dashboardRoute({
  permission: 'firm.read',
  ...sharedAuth,
  handler: async (ctx) => {
    const onchainAddress = await getFirmOnchainAddress(ctx);
    return ctx.json({ onchainAddress });
  },
});

export const PUT = dashboardRoute({
  permission: 'firm.update',
  ...sharedAuth,
  handler: async (ctx) => {
    const limited = await maybeRateLimitResponse(ctx.db, 'firm_wallet_connect', ctx.ip, ctx.now);
    if (limited) return limited;

    const body = await parseBody(ctx.request, ConnectBody);

    // 1. Verify the challenge JWT → extract the nonce it committed to.
    let nonce: string;
    try {
      nonce = await verifyWalletChallenge(body.challenge, getAuthConfig().jwtSecret);
    } catch {
      return ctx.errorJson('invalid_challenge', 'Challenge is invalid or expired.', 400);
    }

    // 2. Recover + verify the address from the SIWE message (checks the nonce
    //    is the one we issued; supports EOA + smart-wallet signatures).
    const address = await verifyEvmWalletSignature({
      message: body.message,
      signature: body.signature as `0x${string}`,
      expectedNonce: nonce,
    });
    if (address === null) {
      return ctx.errorJson('invalid_signature', 'Wallet signature did not verify.', 400);
    }

    // 3. Burn the nonce BEFORE the write so a captured (challenge, message,
    //    signature) tuple cannot be replayed to rebind the address later.
    const fresh = await claimWalletNonce(ctx.db, nonce, ctx.now);
    if (!fresh) {
      return ctx.errorJson('nonce_replay', 'Challenge was already used.', 409);
    }

    await setFirmOnchainAddress(ctx, address);
    return ctx.json({ onchainAddress: address.toLowerCase() });
  },
});

export const DELETE = dashboardRoute({
  permission: 'firm.update',
  ...sharedAuth,
  handler: async (ctx) => {
    await setFirmOnchainAddress(ctx, null);
    return ctx.json({ onchainAddress: null });
  },
});
