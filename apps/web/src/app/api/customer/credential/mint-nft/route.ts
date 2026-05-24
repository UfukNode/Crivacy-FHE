/**
 * POST /api/customer/credential/mint-nft
 *
 * User-triggered showcase NFT mint for an Enhanced KYC credential.
 * The customer picks a theme variant (light / dark) on /kyc step 4
 * and clicks Mint; the chosen SVG bytes are written immutably onto
 * chain in `KycNFT.image`.
 *
 * Pre-conditions, race protection, and theme handling are all in the
 * handler, see `server/handlers/customer-kyc.ts::handleMintNft`.
 */

import { getAuthConfig } from '@/lib/auth/config';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { handleMintNft } from '@/server/handlers/customer-kyc';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = customerRoute({
  handler: handleMintNft,
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
});
