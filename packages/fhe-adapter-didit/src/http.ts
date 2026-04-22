/**
 * Low-level HTTP client for the Didit KYC provider.
 *
 * Mirrors the chain transport layer byte-for-byte in structure —
 * same `FetchLike` shape, same retry semantics, same error
 * mapping — so the two modules feel identical at call sites and
 * the same patterns are re-applied in future third-party clients
 * (e.g. a hypothetical Onfido or Sum&Substance fallback):
 *
 *   * **Timeout** — every call is wrapped in an `AbortController`
 *     keyed to `DiditConfig.requestTimeoutMs`. On timeout we throw
 *     `DiditError('request_timeout', …)`.
 *
 *   * **Retry** — GET reads (session decision polling) are retried
 *     on network + 5xx failures with exponential backoff. POST
 *     writes (session create) are NOT retried automatically —
 *     calling `createSession` twice produces two Didit sessions,
 *     which wastes upstream quota + confuses the user. Callers that
 *     know a POST is safe can opt in via `retry: 'auto'`.
 *
 *   * **Auth** — the api key is attached as `x-api-key` (not Bearer).
 *     This is the only difference from the chain transport — Didit
 *     uses a custom header instead of the standard `Authorization`
 *     token.
 *
 *   * **Response validation** — every 2xx body is parsed through
 *     the provided Zod schema. Shape drift surfaces as
 *     `DiditError('invalid_response', …)` with the Zod issue list
 *     in `cause`.
 *
 *   * **Error mapping** — 4xx and 5xx responses try to parse the
 *     body with `DiditApiErrorSchema` and map to a narrow
 *     `DiditErrorCode`. Unstructured error bodies fall back to
 *     `http_error`.
 *
 * The `fetch` implementation is injected via an optional `fetchImpl`
 * parameter so tests can provide a deterministic stub; production
 * uses the Node 22 built-in `globalThis.fetch`.
 */

import type { z } from 'zod';

import type { DiditConfig } from './config';
import { DiditError } from './errors';
import { type DiditApiError, DiditApiErrorSchema } from './schemas';

/* ---------- Types ---------- */

/**
 * A minimal subset of the Web Fetch API we depend on. Declaring the
 * shape explicitly (instead of importing `typeof fetch`) lets tests
 * provide a pure JS implementation that doesn't need to live in the
 * DOM lib.
 */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

export interface FetchLikeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  text(): Promise<string>;
}

/**
 * Arguments accepted by `diditFetch`. The generic parameter `T` is
 * the shape the caller expects back; it is inferred from `schema`.
 */
export interface DiditFetchOptions<T> {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly schema: z.ZodType<T>;
  /**
   * Retry policy. `auto` retries on transient failures. `never`
   * aborts after the first attempt. Default: `auto` for GET,
   * `never` for POST.
   */
  readonly retry?: 'auto' | 'never';
  /**
   * Extra context attached to error reports — propagated to the
   * observability pipeline via `DiditError.context`.
   */
  readonly context?: Readonly<Record<string, unknown>>;
}

/* ---------- Helpers ---------- */

/**
 * Build the `x-api-key` header. Didit does not use the standard
 * `Authorization` header, so we set the custom one here.
 */
function buildHeaders(config: DiditConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-api-key': config.apiKey,
  };
}

/**
 * Join the config base URL and a path, tolerating leading/trailing
 * slashes. The config loader already strips the trailing slash from
 * the base URL, but we keep the `startsWith('/')` guard for paths
 * that callers supply without a leading slash.
 */
function buildUrl(config: DiditConfig, path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${config.baseUrl}${normalized}`;
}

/**
 * Encode a request body to a JSON string. Didit's session create
 * payload is tiny (<1 KB), so we do not impose a size cap — but we
 * still catch any `JSON.stringify` failure and wrap it.
 */
function encodeBody(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch (err) {
    throw new DiditError('unexpected', 'Failed to serialize Didit request body to JSON.', {
      cause: err,
    });
  }
}

/**
 * Attempt to parse a response body as the Didit structured error
 * shape. Returns `null` when parsing fails (e.g. HTML error page,
 * empty body). Used to decide between `http_error` (generic) and
 * the more specific codes.
 */
function tryParseStructuredError(rawBody: string): DiditApiError | null {
  if (rawBody.length === 0) {
    return null;
  }
  try {
    const json: unknown = JSON.parse(rawBody);
    const parsed = DiditApiErrorSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Extract a human-readable cause string from a parsed structured
 * error, falling back to a truncated raw body if the structure is
 * absent. Bounded to 1 KiB so error messages never blow up logs.
 */
function summarizeCause(structured: DiditApiError | null, rawBody: string): string {
  if (structured) {
    return (
      structured.detail ??
      structured.message ??
      structured.error ??
      structured.code ??
      rawBody.slice(0, 1024)
    );
  }
  return rawBody.slice(0, 1024);
}

/**
 * Translate an HTTP failure into the narrowest possible Didit error
 * code. 401 / 403 / 404 / 429 get dedicated codes so route handlers
 * can branch; 5xx maps to `service_unavailable`.
 */
function mapHttpError(
  status: number,
  rawBody: string,
  context: Readonly<Record<string, unknown>>,
): DiditError {
  const structured = tryParseStructuredError(rawBody);
  const cause = summarizeCause(structured, rawBody);
  const fullContext = {
    ...context,
    status,
    ...(structured ? { upstreamError: structured } : {}),
  };

  if (status === 401) {
    return new DiditError('unauthorized', `Didit rejected our api key (401): ${cause}`, {
      context: fullContext,
    });
  }
  if (status === 403) {
    return new DiditError('forbidden', `Didit refused the request (403): ${cause}`, {
      context: fullContext,
    });
  }
  if (status === 404) {
    return new DiditError('not_found', `Didit resource not found (404): ${cause}`, {
      context: fullContext,
    });
  }
  if (status === 429) {
    return new DiditError('rate_limited', `Didit rate-limited the request (429): ${cause}`, {
      context: fullContext,
    });
  }
  if (status >= 500 && status <= 599) {
    return new DiditError('service_unavailable', `Didit returned ${status}: ${cause}`, {
      context: fullContext,
    });
  }
  return new DiditError('http_error', `Didit returned ${status}: ${cause}`, {
    context: fullContext,
  });
}

/**
 * Decide whether a fetch error is transient (retryable) or fatal.
 * Network hiccups and 5xx are transient; structured rejections
 * (unauthorized, not_found) are not. 429 is retryable but needs a
 * longer backoff — we let the caller decide by surfacing the code.
 */
function isTransient(err: DiditError): boolean {
  return (
    err.code === 'network_error' ||
    err.code === 'request_timeout' ||
    err.code === 'service_unavailable' ||
    err.code === 'rate_limited'
  );
}

/**
 * Sleep for `ms` milliseconds, wrapped in a promise. Extracted so
 * tests can stub it without faking `setTimeout`.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ---------- Core ---------- */

/**
 * Execute a single (non-retried) HTTP call against Didit. Parses
 * the response through the provided schema.
 *
 * Exposed mainly for tests and for the retry loop. Callers in
 * `session.ts` should use `diditFetch`.
 */
export async function diditFetchOnce<T>(
  config: DiditConfig,
  options: DiditFetchOptions<T>,
  fetchImpl: FetchLike,
): Promise<T> {
  const url = buildUrl(config, options.path);
  const headers = buildHeaders(config);
  const body = options.body !== undefined ? encodeBody(options.body) : undefined;
  const context: Readonly<Record<string, unknown>> = {
    method: options.method,
    path: options.path,
    ...(options.context ?? {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, config.requestTimeoutMs);

  let response: FetchLikeResponse;
  try {
    response = await fetchImpl(url, {
      method: options.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (isAbortError(err)) {
      throw new DiditError(
        'request_timeout',
        `Didit request timed out after ${config.requestTimeoutMs}ms: ${options.method} ${options.path}`,
        { cause: err, context },
      );
    }
    throw new DiditError(
      'network_error',
      `Didit request failed with a network error: ${options.method} ${options.path}`,
      { cause: err, context },
    );
  } finally {
    clearTimeout(timer);
  }

  const rawBody = await response.text().catch((readErr: unknown) => {
    throw new DiditError('network_error', 'Failed to read Didit response body.', {
      cause: readErr,
      context,
    });
  });

  if (!response.ok) {
    throw mapHttpError(response.status, rawBody, context);
  }

  if (rawBody.length === 0) {
    throw new DiditError(
      'empty_response',
      `Didit returned an empty 2xx body: ${options.method} ${options.path}`,
      { context },
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch (jsonErr) {
    throw new DiditError(
      'invalid_response',
      `Didit returned non-JSON body: ${options.method} ${options.path}`,
      {
        cause: jsonErr,
        context: { ...context, rawBodyPrefix: rawBody.slice(0, 512) },
      },
    );
  }

  const validated = options.schema.safeParse(parsedJson);
  if (!validated.success) {
    throw new DiditError(
      'invalid_response',
      `Didit response failed schema validation: ${options.method} ${options.path}`,
      {
        cause: validated.error,
        context: {
          ...context,
          issues: validated.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      },
    );
  }
  return validated.data;
}

/**
 * Public entry point. Performs the fetch, retries on transient
 * failures for idempotent calls, and returns the validated body.
 */
export async function diditFetch<T>(
  config: DiditConfig,
  options: DiditFetchOptions<T>,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<T> {
  const retryMode: 'auto' | 'never' =
    options.retry ?? (options.method === 'GET' ? 'auto' : 'never');
  const maxAttempts = retryMode === 'auto' ? config.maxRetries + 1 : 1;

  let lastError: DiditError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await diditFetchOnce(config, options, fetchImpl);
    } catch (err) {
      if (!(err instanceof DiditError)) {
        // Programmer error — don't retry.
        throw DiditError.wrap(
          'unexpected',
          'Didit fetch raised a non-DiditError.',
          err,
          options.context,
        );
      }
      lastError = err;
      if (retryMode === 'never' || !isTransient(err) || attempt >= maxAttempts) {
        throw err;
      }
      // Exponential backoff: base * 2^(attempt-1). Bounded by the
      // outer request timeout so total wait never exceeds it.
      const backoff = Math.min(
        config.retryBaseDelayMs * 2 ** (attempt - 1),
        config.requestTimeoutMs,
      );
      await delay(backoff);
    }
  }
  // Unreachable — the loop either returns or throws. Typescript
  // needs the fallback for control-flow narrowing.
  throw (
    lastError ?? new DiditError('unexpected', 'Didit fetch exhausted retries without an error.')
  );
}

/* ---------- Abort detection ---------- */

/**
 * Detect a fetch-level abort. Different fetch implementations
 * surface this differently: Node's undici sets
 * `err.name === 'AbortError'`, while the Web standard uses a
 * `DOMException` with `code === 20`.
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') {
    return true;
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 20
  ) {
    return true;
  }
  return false;
}
