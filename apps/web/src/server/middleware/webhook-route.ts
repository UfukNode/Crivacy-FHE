/**
 * Webhook route builder — for inbound provider webhooks (e.g. Didit).
 *
 * Pipeline:
 *   1. Build `RequestContext` (requestId, db, now, ip, ua)
 *   2. Read raw body text (no JSON parse yet — we need the bytes for
 *      HMAC verification)
 *   3. Parse JSON from raw text
 *   4. Call the user-provided verify + handle function with the raw
 *      body, parsed JSON, and headers
 *   5. On success → return the handler response
 *   6. On error → map via error-mapper → ctx.errorJson()
 *
 * Important: after HMAC verification succeeds, the handler should
 * always return 200 to the provider (even on internal errors) to
 * prevent retries. This is handled in the handler itself, not here.
 *
 * @module
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';

import type { CrivacyDatabase } from '@/lib/db/client';
import { getDatabaseClient } from '@/lib/db/client';

import { type RequestContext, buildRequestContext } from '../context';
import { mapErrorToResponse } from './error-mapper';
import { ParseError } from './parse';

/** Maximum body size for inbound webhooks: 256 KiB. */
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * The webhook handler receives the base context plus the parsed
 * headers and body. It is responsible for HMAC verification and
 * business logic.
 */
export interface WebhookInput {
  readonly rawBody: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export type WebhookHandler = (
  ctx: RequestContext,
  input: WebhookInput,
) => Promise<NextResponse> | NextResponse;

/**
 * Build a Next.js App Router handler for an inbound webhook endpoint.
 */
export function webhookRoute(
  handler: WebhookHandler,
  options?: {
    readonly maxBodyBytes?: number;
    readonly dbFactory?: () => CrivacyDatabase;
    readonly clock?: () => Date;
    readonly requestIdFactory?: () => string;
  },
): (request: NextRequest) => Promise<NextResponse> {
  const getDb = options?.dbFactory ?? (() => getDatabaseClient().db);
  const clock = options?.clock;
  const requestIdFactory = options?.requestIdFactory;
  const maxBytes = options?.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES;

  return async (request: NextRequest): Promise<NextResponse> => {
    const db = getDb();
    const ctx = buildRequestContext(request, db, clock, requestIdFactory);

    try {
      // --- 1. Read raw body ---
      const rawBody = await readRawBody(request, maxBytes);

      // --- 2. Parse JSON ---
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch (cause) {
        throw new ParseError('malformed_json', 'Webhook body is not valid JSON.', { cause });
      }

      // --- 3. Collect headers (lowercased keys) ---
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      // --- 4. Call handler ---
      return await handler(ctx, {
        rawBody,
        body,
        headers: Object.freeze(headers),
      });
    } catch (err) {
      if (err instanceof ParseError) {
        const status =
          err.code === 'payload_too_large'
            ? 413
            : err.code === 'unsupported_media_type'
              ? 415
              : 400;
        return ctx.errorJson(err.code, err.message, status);
      }
      const mapped = mapErrorToResponse(err);
      return ctx.errorJson(mapped.code, mapped.message, mapped.status, mapped.details);
    }
  };
}

/**
 * Read the request body as text with a byte-length limit.
 */
async function readRawBody(request: NextRequest, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number.parseInt(contentLength, 10);
    if (!Number.isNaN(declared) && declared > maxBytes) {
      throw new ParseError('payload_too_large', `Webhook body exceeds the ${maxBytes} byte limit.`);
    }
  }

  const text = await request.text();
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > maxBytes) {
    throw new ParseError('payload_too_large', `Webhook body exceeds the ${maxBytes} byte limit.`);
  }

  return text;
}
