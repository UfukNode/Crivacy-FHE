/**
 * POST /api/webhooks/didit, inbound Didit KYC decision webhook.
 *
 * Public webhook endpoint, no API key auth. HMAC signature verification
 * is handled inside the handler itself (verifyWebhook from lib/didit).
 */

import { handleDiditWebhook } from '@/server/handlers';
import { webhookRoute } from '@/server/middleware/webhook-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = webhookRoute((ctx, input) => handleDiditWebhook(ctx, input));
