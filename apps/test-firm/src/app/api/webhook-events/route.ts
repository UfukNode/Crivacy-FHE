/**
 * GET /api/webhook-events — list recent webhook deliveries.
 *
 * Read-only view over the in-memory webhook log for the dashboard
 * poller. Guarded by the TestFirm session cookie so webhook payloads
 * (which may include real PII in prod-like tests) don't leak to
 * unauthenticated browsers.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { listWebhookEvents } from '../../data-store';
import { TF_SESSION_COOKIE } from '../../session';
import { findUserBySession } from '../../user-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(TF_SESSION_COOKIE)?.value ?? null;
  const user = findUserBySession(token);
  if (user === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const entries = listWebhookEvents().map((entry) => ({
    id: entry.id,
    receivedAt: entry.receivedAt,
    eventType: entry.eventType,
    eventId: entry.crivacyEventId,
    deliveryId: entry.crivacyDeliveryId,
    signatureValid: entry.signatureValid,
    payload: entry.payload,
  }));

  return NextResponse.json({ entries }, { status: 200 });
}
