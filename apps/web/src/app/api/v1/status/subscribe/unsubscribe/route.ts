/**
 * GET /api/v1/status/subscribe/unsubscribe?token=<uuid>, unsubscribe.
 */

import { publicRoute } from '@/server/middleware/public-route';
import { unsubscribeByToken } from '@/server/repositories/status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = publicRoute(async (ctx) => {
  const url = new URL(ctx.request.url);
  const token = url.searchParams.get('token');

  if (token === null || token.length === 0) {
    return ctx.errorJson('missing_token', 'Unsubscribe token is required.', 400);
  }

  const unsubscribed = await unsubscribeByToken(ctx.db, token);
  if (!unsubscribed) {
    return ctx.errorJson('invalid_token', 'Token is invalid or already unsubscribed.', 404);
  }

  return ctx.json({ unsubscribed: true, message: 'You have been unsubscribed.' });
});
