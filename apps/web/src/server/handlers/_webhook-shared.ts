/**
 * Shared helpers used by both webhook handler surfaces — the public
 * `/api/v1/webhooks/*` routes (API-key auth) and the dashboard-side
 * `/api/internal/webhooks/*` routes (session auth). Keeping these in
 * one place matches the `_ticket-shared.ts` pattern and prevents
 * drift between the two surfaces (e.g. response shape changes on
 * one side but not the other).
 *
 * Pure / stateless helpers only. Middleware, context handling, and
 * permission checks live in the individual handlers.
 *
 * @module
 */

import { z } from 'zod';

import { loadKeyFromBase64, seal } from '@/lib/auth/crypto-box';
import type { WebhookEndpoint } from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Path + cursor primitives
// ---------------------------------------------------------------------------

/** `{id}` path-param schema used by every `/webhooks/{id}` endpoint. */
export const WebhookIdParams = z.object({ id: z.uuid() });

/**
 * Serialize a `(createdAt, id)` cursor into a base64url token. Stable
 * across both surfaces so a cursor minted by the public API works if
 * handed to the dashboard (and vice versa).
 */
export function encodeWebhookCursor(cursor: { readonly ts: Date; readonly id: string }): string {
  return Buffer.from(
    JSON.stringify({ ts: cursor.ts.toISOString(), id: cursor.id }),
  ).toString('base64url');
}

export function decodeWebhookCursor(
  raw: string,
): { readonly ts: Date; readonly id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj['ts'] !== 'string' || typeof obj['id'] !== 'string') return null;
    const ts = new Date(obj['ts']);
    if (Number.isNaN(ts.getTime())) return null;
    return { ts, id: obj['id'] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

/**
 * Public DTO shape for a webhook endpoint. Both surfaces return this
 * structure; any differences belong in separate handler layers (e.g.
 * the dashboard list endpoint can add internal fields, but the
 * baseline must stay aligned with the public API contract).
 */
export interface WebhookEndpointSummary {
  readonly id: string;
  readonly firmId: string;
  readonly url: string;
  readonly description: string | null;
  readonly events: readonly string[];
  readonly active: boolean;
  readonly secretMasked: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastDeliveryAt: string | null;
  readonly failureCount: number;
}

/**
 * Project a `WebhookEndpoint` row to the shared public DTO. The
 * signing secret is NEVER included here — it only leaves the server
 * once, in the create-endpoint response body. Callers that need the
 * raw secret build the response manually at creation time.
 */
export function endpointToSummary(ep: WebhookEndpoint): WebhookEndpointSummary {
  return {
    id: ep.id,
    firmId: ep.firmId,
    url: ep.url,
    description: ep.label.length > 0 ? ep.label : null,
    events: ep.events,
    active: ep.disabledAt === null,
    // Secret is encrypted at rest; the plaintext is only shown once at
    // creation. Masked placeholder carries the format expectation so
    // UIs can render a credible "••••" column.
    secretMasked: 'whsec_••••••••••••••••',
    createdAt: ep.createdAt.toISOString(),
    updatedAt: ep.updatedAt.toISOString(),
    lastDeliveryAt: ep.lastSuccessAt !== null ? ep.lastSuccessAt.toISOString() : null,
    failureCount: ep.consecutiveFailures,
  };
}

// ---------------------------------------------------------------------------
// Signing-secret generation
// ---------------------------------------------------------------------------

/** Key version stamped onto every newly-generated webhook signing secret. Bump when the encryption key is rotated. */
export const WEBHOOK_SIGNING_KEY_VERSION = 1;

export interface GeneratedSigningSecret {
  /** Raw `whsec_*` secret — surface to the caller once, never stored. */
  readonly plaintext: string;
  /** AES-GCM ciphertext ready for DB insert. */
  readonly ciphertext: Buffer;
  /** AES-GCM nonce ready for DB insert. */
  readonly nonce: Buffer;
  /** Encryption key version stamped on the row. */
  readonly keyVersion: number;
}

/**
 * Mint a fresh `whsec_*` signing secret and seal it with the
 * webhook encryption key. The plaintext is returned so the caller
 * can include it exactly once in the create response; everywhere
 * else only the ciphertext + nonce land in the DB, and the secret
 * is rebuilt on demand when signing outgoing deliveries.
 *
 * `AUTH_WEBHOOK_ENCRYPTION_KEY` is validated at startup — if it's
 * missing or wrong length this throws at the `loadKeyFromBase64`
 * step, and the caller surfaces a 500.
 */
export function generateSigningSecret(): GeneratedSigningSecret {
  const entropy = crypto.getRandomValues(new Uint8Array(32));
  const secretHex = Array.from(entropy)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const plaintext = `whsec_${secretHex}`;

  const keyBase64 = process.env['AUTH_WEBHOOK_ENCRYPTION_KEY'] ?? '';
  const key = loadKeyFromBase64(keyBase64);
  const sealed = seal(plaintext, key, WEBHOOK_SIGNING_KEY_VERSION);

  return {
    plaintext,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    keyVersion: WEBHOOK_SIGNING_KEY_VERSION,
  };
}
