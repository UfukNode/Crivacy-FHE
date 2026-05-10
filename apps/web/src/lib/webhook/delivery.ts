import { buildWebhookHeaders } from './signature';

/* ---------- Types ---------- */

export interface DeliverySuccess {
  readonly success: true;
  readonly httpStatus: number;
  readonly latencyMs: number;
  readonly responseBodySample: string;
}

export interface DeliveryFailure {
  readonly success: false;
  readonly httpStatus: number | null;
  readonly error: string;
  readonly latencyMs: number;
  readonly responseBodySample: string | null;
}

export type DeliveryResult = DeliverySuccess | DeliveryFailure;

export interface DeliveryInput {
  readonly url: string;
  readonly body: string;
  readonly secret: string;
  readonly eventId: string;
  readonly deliveryId: string;
  readonly timestamp: number;
}

/**
 * Minimal fetch interface for dependency injection.
 */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string> }>;

/* ---------- Execution ---------- */

/**
 * Execute a single webhook delivery — POST to the firm's URL with
 * HMAC-signed headers and capture the result.
 *
 * @param input - Delivery parameters (url, body, secret, etc.)
 * @param timeoutMs - Request timeout in milliseconds
 * @param maxResponseBytes - Max response body bytes to store
 * @param fetchImpl - Fetch implementation (default: global fetch)
 * @param clock - Clock function for latency measurement
 * @returns DeliveryResult
 */
export async function executeDelivery(
  input: DeliveryInput,
  timeoutMs = 10_000,
  maxResponseBytes = 1024,
  fetchImpl?: FetchLike,
  clock: () => number = Date.now,
): Promise<DeliveryResult> {
  const doFetch = fetchImpl ?? (globalThis.fetch as FetchLike);
  const headers = buildWebhookHeaders(
    input.secret,
    input.body,
    input.eventId,
    input.deliveryId,
    input.timestamp,
  );

  const startMs = clock();
  let controller: AbortController | undefined;

  try {
    controller = new AbortController();
    const timeoutId = setTimeout(() => controller?.abort(), timeoutMs);

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(input.url, {
        method: 'POST',
        headers,
        body: input.body,
        // SSRF hardening (AUDIT H-1): never follow redirects. The URL is
        // re-validated by the SSRF guard before delivery, but a firm
        // controls the server at that validated URL and could answer with
        // `302 Location: http://169.254.169.254/...` (cloud metadata) or an
        // internal address. With `redirect: 'error'` undici rejects instead
        // of transparently following the hop, so the guard cannot be
        // bypassed via a redirect. A webhook receiver has no legitimate
        // reason to redirect.
        redirect: 'error',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const latencyMs = clock() - startMs;
    const rawBody = await response.text();
    const responseBodySample = truncateBody(rawBody, maxResponseBytes);

    if (response.ok) {
      return {
        success: true,
        httpStatus: response.status,
        latencyMs,
        responseBodySample,
      };
    }

    return {
      success: false,
      httpStatus: response.status,
      error: `HTTP ${response.status} ${response.statusText}`,
      latencyMs,
      responseBodySample,
    };
  } catch (err) {
    const latencyMs = clock() - startMs;

    if (isAbortError(err)) {
      return {
        success: false,
        httpStatus: null,
        error: `Request timed out after ${timeoutMs}ms`,
        latencyMs,
        responseBodySample: null,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      httpStatus: null,
      error: `Network error: ${message}`,
      latencyMs,
      responseBodySample: null,
    };
  }
}

/* ---------- Helpers ---------- */

function truncateBody(body: string, maxBytes: number): string {
  if (body.length <= maxBytes) return body;
  return `${body.slice(0, maxBytes)}…[truncated]`;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true;
    if ((err as { code?: number }).code === 20) return true;
  }
  return false;
}

/**
 * Check if a delivery result indicates a transient error that should
 * be retried (5xx, timeout, network error).
 */
export function isTransientFailure(result: DeliveryResult): boolean {
  if (result.success) return false;
  // No HTTP status means network/timeout error — transient
  if (result.httpStatus === null) return true;
  // 5xx is transient
  if (result.httpStatus >= 500) return true;
  // 429 is transient (rate limited by the receiver)
  if (result.httpStatus === 429) return true;
  // 4xx (except 429) is permanent — don't retry
  return false;
}
