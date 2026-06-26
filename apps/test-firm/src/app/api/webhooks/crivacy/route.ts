/**
 * POST /api/webhooks/crivacy — TestFirm's webhook receiver.
 *
 * Verifies Crivacy's outbound HMAC signature before accepting the
 * event. The signature format mirrors Stripe's: header
 *   X-Crivacy-Signature: t=<unix>,v1=<hex-sha256>
 * where the HMAC is computed over `${timestamp}.${rawBody}` with
 * the endpoint's signing secret.
 *
 * Three failure modes:
 *   - 500 when TEST_FIRM_WEBHOOK_SECRET is not configured. This is a
 *     setup error; the receiver won't silently accept unverified
 *     events. Register an endpoint in the Crivacy dashboard and
 *     copy the one-time secret into `.env`.
 *   - 401 on a malformed/absent signature header or a mismatch.
 *   - 400 on a body that isn't valid JSON.
 *
 * A 2xx response writes the event to the in-memory webhook log and
 * the dashboard picks it up on the next poll.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

import { loadTestFirmConfig } from '../../../config';
import {
  markOauthIdentityExpired,
  markOauthIdentityRevoked,
  recordWebhookEvent,
  updateKycSessionStatus,
} from '../../../data-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIGNATURE_HEADER = 'x-crivacy-signature';
const EVENT_ID_HEADER = 'x-crivacy-event-id';
const DELIVERY_ID_HEADER = 'x-crivacy-delivery-id';
const TOLERANCE_SECONDS = 300;

interface ParsedSignature {
  readonly timestamp: number;
  readonly v1: string;
}

function parseSignature(header: string): ParsedSignature | null {
  const parts = header.split(',');
  let timestamp: number | null = null;
  let v1: string | null = null;
  for (const raw of parts) {
    const kv = raw.trim().split('=');
    if (kv.length !== 2) continue;
    const [k, v] = kv;
    if (k === 't') {
      const parsed = Number.parseInt(v ?? '', 10);
      if (Number.isInteger(parsed) && parsed > 0) timestamp = parsed;
    } else if (k === 'v1') {
      if (typeof v === 'string' && v.length > 0) v1 = v;
    }
  }
  if (timestamp === null || v1 === null) return null;
  return { timestamp, v1 };
}

function verifySignature(
  secret: string,
  rawBody: string,
  parsed: ParsedSignature,
  nowSeconds: number,
): boolean {
  if (Math.abs(nowSeconds - parsed.timestamp) > TOLERANCE_SECONDS) return false;

  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  if (expected.length !== parsed.v1.length) return false;

  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(parsed.v1, 'utf8');
  return timingSafeEqual(expectedBuf, receivedBuf);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const cfg = loadTestFirmConfig();
  if (cfg.webhookSecret === null) {
    return NextResponse.json(
      {
        error: 'webhook_secret_missing',
        message:
          'TEST_FIRM_WEBHOOK_SECRET is not set. Register a webhook endpoint in the Crivacy dashboard, copy the secret to .env, and restart.',
      },
      { status: 500 },
    );
  }

  const rawBody = await request.text();
  const sigHeader = request.headers.get(SIGNATURE_HEADER);
  const eventId = request.headers.get(EVENT_ID_HEADER);
  const deliveryId = request.headers.get(DELIVERY_ID_HEADER);

  if (sigHeader === null) {
    return NextResponse.json(
      { error: 'missing_signature' },
      { status: 401 },
    );
  }

  const parsed = parseSignature(sigHeader);
  if (parsed === null) {
    return NextResponse.json(
      { error: 'malformed_signature' },
      { status: 401 },
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ok = verifySignature(cfg.webhookSecret, rawBody, parsed, nowSeconds);
  if (!ok) {
    return NextResponse.json(
      { error: 'signature_mismatch' },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 });
  }

  const eventType =
    typeof (payload as { type?: unknown })?.type === 'string'
      ? (payload as { type: string }).type
      : 'unknown';

  recordWebhookEvent({
    eventType,
    crivacyEventId: eventId,
    crivacyDeliveryId: deliveryId,
    signatureValid: true,
    payload,
  });

  // If this is a session lifecycle event, mirror the new status onto
  // the corresponding KycSessionRecord so the dashboard list reflects
  // reality without a refresh.
  if (eventType.startsWith('session.')) {
    const data = (payload as { data?: unknown }).data;
    if (typeof data === 'object' && data !== null) {
      const sessionId = (data as { id?: unknown }).id;
      const status = (data as { status?: unknown }).status;
      if (typeof sessionId === 'string' && typeof status === 'string') {
        updateKycSessionStatus(sessionId, status);
      }
    }
  }

  // Credential lifecycle → flip the matching OAuth identity record.
  // `credential.revoked` / `credential.expired` events let the
  // verified hero card switch to a revoked banner without a
  // page refresh OR a manual re-OAuth — same SoT the dashboard
  // already reads. The match key is `claims.sub` (Crivacy user id);
  // unknown subs are ignored loudly (logged but 200'd so Crivacy
  // doesn't retry forever).
  if (eventType === 'credential.revoked' || eventType === 'credential.expired') {
    const data = (payload as { data?: unknown }).data;
    if (typeof data === 'object' && data !== null) {
      const sub = (data as { sub?: unknown; userId?: unknown }).sub;
      const userId = (data as { sub?: unknown; userId?: unknown }).userId;
      // Crivacy emits the customer reference under different keys
      // across event shapes (`sub` for OIDC-style claims, `userId`
      // for direct credential events). Accept both.
      const crivacySub =
        typeof sub === 'string' && sub.length > 0
          ? sub
          : typeof userId === 'string' && userId.length > 0
            ? userId
            : null;
      if (crivacySub !== null) {
        if (eventType === 'credential.revoked') {
          const reason =
            typeof (data as { reason?: unknown }).reason === 'string'
              ? ((data as { reason: string }).reason)
              : 'revoked';
          markOauthIdentityRevoked({ crivacySub, reason });
        } else {
          markOauthIdentityExpired({ crivacySub });
        }
      }
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
