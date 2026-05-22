/**
 * POST /api/v1/status/subscribe, subscribe to status updates.
 *
 * Public endpoint. Accepts { email, componentIds? } and creates a
 * pending subscriber record. Confirmation is done via the confirm
 * token (in a real deployment, this would be emailed).
 */

import { z } from 'zod';
import { parseBody } from '@/server/middleware/parse';
import { publicRoute } from '@/server/middleware/public-route';
import { subscribeEmail } from '@/server/repositories/status';
import { emailSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SubscribeBody = z.object({
  email: emailSchema,
  componentIds: z.array(z.string()).optional().default([]),
});

export const POST = publicRoute(async (ctx) => {
  const body = await parseBody(ctx.request, SubscribeBody, 4096);

  const { email, componentIds } = body;

  const result = await subscribeEmail(ctx.db, email, componentIds);

  return ctx.json(
    {
      subscribed: true,
      confirmed: false,
      message: result.isNew
        ? 'Subscription created. Please check your email to confirm.'
        : 'You are already subscribed. Check your email for confirmation if not yet confirmed.',
    },
    result.isNew ? 201 : 200,
  );
});
