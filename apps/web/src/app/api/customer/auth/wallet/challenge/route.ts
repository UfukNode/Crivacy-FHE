/**
 * POST /api/customer/auth/wallet/challenge
 *
 * Generate a nonce for Sign-In With Ethereum (EIP-4361). The client connects
 * the user's EVM wallet, builds the SIWE message with this nonce + the connected
 * address + the app domain, asks the wallet to sign it, then submits the message
 * + signature to /api/customer/auth/wallet/verify.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { buildRequestContext } from '@/server/context';

import { generateWalletChallenge } from '@/lib/customer/evm-wallet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = getDatabaseClient().db;
  const ctx = buildRequestContext(request, db);
  const authConfig = getAuthConfig();

  const { challengeJwt, nonce } = await generateWalletChallenge(authConfig.jwtSecret);

  return ctx.json({
    challenge: challengeJwt,
    nonce,
  });
}
