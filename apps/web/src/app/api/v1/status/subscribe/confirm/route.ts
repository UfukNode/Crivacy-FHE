/**
 * GET /api/v1/status/subscribe/confirm?token=<uuid>, confirm subscription.
 */

import { publicRoute } from '@/server/middleware/public-route';
import { confirmSubscription } from '@/server/repositories/status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = publicRoute(async (ctx) => {
  const url = new URL(ctx.request.url);
  const token = url.searchParams.get('token');

  if (token === null || token.length === 0) {
    return ctx.errorJson('missing_token', 'Confirmation token is required.', 400);
  }

  const confirmed = await confirmSubscription(ctx.db, token);
  if (!confirmed) {
    return ctx.errorJson('invalid_token', 'Token is invalid or already confirmed.', 404);
  }

  return ctx.json({ confirmed: true, message: 'Your subscription has been confirmed.' });
});
