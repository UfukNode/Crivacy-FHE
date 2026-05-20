/**
 * Playground proxy handler — executes API v1 requests on behalf of the
 * dashboard user using their selected API key.
 *
 * Security: the user must own the API key (belongs to the same firm).
 * Rate limits + audit logging apply to playground calls the same as
 * real API calls.
 *
 * @module
 */

import { getAuthConfig } from '@/lib/auth/config';
import { PLAYGROUND_TOKEN_HEADER, createPlaygroundToken } from '@/lib/auth/playground-token';

import type { DashboardContext } from '../context';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlaygroundExecuteInput {
  /** HTTP method */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** API path, must start with /api/v1/ */
  readonly path: string;
  /** Optional request headers (api key header is injected by the proxy) */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional request body (JSON) */
  readonly body?: unknown;
}

export interface PlaygroundExecuteResult {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly latencyMs: number;
}

export interface PlaygroundDeps {
  /** Look up an API key row by ID + firm to get the raw prefix for injection. */
  readonly findApiKeyForPlayground: (
    db: import('@/lib/db/client').CrivacyDatabase,
    keyId: string,
    firmId: string,
  ) => Promise<{ id: string; prefix: string; keyHash: string; mode: string } | null>;
  /** The base URL to proxy to (e.g. http://127.0.0.1:3001 or derived from request). */
  readonly resolveBaseUrl: (request: Request) => string;
  /** Fetch implementation (injected for testing). */
  readonly fetchImpl?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ALLOWED_PATH_PREFIX = '/api/v1/';
const MAX_BODY_BYTES = 64 * 1024;
const PROXY_TIMEOUT_MS = 30_000;
/**
 * Max characters we accept in `input.path` before normalisation. Matches
 * the Zod bound on the route but re-asserted here so the handler is
 * self-contained — SSRF defense should not depend on the caller's
 * validator.
 */
const MAX_PATH_LENGTH = 2048;
/**
 * Upper bound on the proxied response body. A rogue (or misbehaving)
 * `/api/v1/*` endpoint could return a multi-megabyte payload; fully
 * buffering it is a memory-DoS vector against the dashboard process.
 * 2 MB is ample headroom for every real v1 response we ship today.
 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Regex matching any character that has no business in an HTTP header value. */
// eslint-disable-next-line no-control-regex
const HEADER_CTRL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

// Headers that must NOT be forwarded from the playground request
const BLOCKED_HEADERS = new Set([
  'host',
  'connection',
  'transfer-encoding',
  'content-length',
  'authorization',
  'x-api-key',
  'cookie',
]);

/**
 * SSRF / path-traversal guard. Returns an error descriptor on reject,
 * or `null` when the path is safe to proxy.
 *
 * The function is deliberately allocation-heavy (constructing a URL,
 * re-checking fields) because this is exactly the kind of code where
 * cleverness kills: every bypass of the old `startsWith` check was a
 * clever shortcut that a spec-compliant parser rejects.
 */
type ProxyPathResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly code: string; readonly message: string };

function validateProxyPath(path: string, baseOrigin: string): ProxyPathResult {
  if (path.length === 0) {
    return { ok: false, code: 'invalid_path', message: 'Path is required.' };
  }
  if (path.length > MAX_PATH_LENGTH) {
    return {
      ok: false,
      code: 'invalid_path',
      message: `Path exceeds ${MAX_PATH_LENGTH} characters.`,
    };
  }

  // Must be an absolute path (rejects schema-relative `//evil.com/x`,
  // scheme-absolute `http://…`, and anything starting with `@` which
  // could be read as a userinfo segment.)
  if (!path.startsWith('/') || path.startsWith('//')) {
    return {
      ok: false,
      code: 'invalid_path',
      message: 'Path must be a single-slash absolute path.',
    };
  }

  // Reject control/whitespace characters outright. The WHATWG URL
  // parser will typically percent-encode them, but disallowing them
  // up front means log analysis stays clean and no CRLF smuggling
  // into downstream request lines.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\s]/.test(path)) {
    return {
      ok: false,
      code: 'invalid_path',
      message: 'Path contains control characters or whitespace.',
    };
  }

  // Prefix fast-reject — saves the URL allocation for obvious misses.
  if (!path.startsWith(ALLOWED_PATH_PREFIX)) {
    return {
      ok: false,
      code: 'invalid_path',
      message: `Path must start with ${ALLOWED_PATH_PREFIX}`,
    };
  }

  // Resolve with the WHATWG parser against the server origin so
  // `.` / `..` segments normalise and anything that escapes the
  // `/api/v1/` prefix surfaces cleanly. If parsing fails, reject —
  // the normal path never produces a URL the parser refuses.
  let resolved: URL;
  try {
    resolved = new URL(path, baseOrigin);
  } catch {
    return { ok: false, code: 'invalid_path', message: 'Path is not a valid URL.' };
  }

  const baseUrl = new URL(baseOrigin);
  if (resolved.origin !== baseUrl.origin) {
    return { ok: false, code: 'invalid_path', message: 'Path must stay on the same origin.' };
  }
  if (!resolved.pathname.startsWith(ALLOWED_PATH_PREFIX)) {
    return {
      ok: false,
      code: 'invalid_path',
      message: `Normalised path must stay under ${ALLOWED_PATH_PREFIX}`,
    };
  }

  return { ok: true, url: resolved };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Execute an API v1 request on behalf of the dashboard user.
 *
 * The handler:
 * 1. Validates the path is under /api/v1/
 * 2. Verifies the provided API key belongs to the user's firm
 * 3. Proxies the request to the local server with the API key injected
 * 4. Returns the response status, headers, body, and latency
 */
export async function handlePlaygroundExecute(
  deps: PlaygroundDeps,
  ctx: DashboardContext,
  input: PlaygroundExecuteInput,
  apiKeyId: string,
): Promise<PlaygroundExecuteResult> {
  // 1. Validate path — multi-stage defense against SSRF.
  //
  // A naive `startsWith('/api/v1/')` check is trivially bypassed by
  // traversal (`/api/v1/../internal/admin`) or authority injection
  // (`/api/v1/@evil.com/x` → parsed as host=evil.com when combined
  // with a bare origin prefix). We reject both by:
  //
  //   1. Capping the raw length so pathological inputs can't exhaust
  //      the parser.
  //   2. Rejecting any character that could be interpreted as an
  //      authority boundary or a control/CRLF sequence.
  //   3. Resolving the final URL against the server origin with the
  //      WHATWG `URL` parser, then re-checking origin + pathname
  //      against the `/api/v1/` prefix — normalisation handled by
  //      the browser-spec parser, not our own code.
  const baseOrigin = deps.resolveBaseUrl(ctx.request);
  const pathCheck = validateProxyPath(input.path, baseOrigin);
  if (!pathCheck.ok) {
    return {
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      body: { error: { code: pathCheck.code, message: pathCheck.message } },
      latencyMs: 0,
    };
  }
  const proxyUrl = pathCheck.url;

  // 2. Look up API key
  const apiKey = await deps.findApiKeyForPlayground(ctx.db, apiKeyId, ctx.firm.id);
  if (apiKey === null) {
    return {
      status: 404,
      statusText: 'Not Found',
      headers: {},
      body: {
        error: {
          code: 'api_key_not_found',
          message: 'API key not found or does not belong to your firm.',
        },
      },
      latencyMs: 0,
    };
  }

  // Playground is a **test surface**. Running a live-mode key here
  // would mint real KYC sessions, trigger real webhook deliveries,
  // and bill the firm for work done from a dashboard form — a
  // common and expensive foot-gun. The OpenAPI contract documents
  // this rejection; enforce it here so the docs don't drift ahead
  // of the code.
  if (apiKey.mode !== 'test') {
    return {
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      body: {
        error: {
          code: 'invalid_argument',
          message: 'Playground only accepts test-mode API keys. Create a test key and retry.',
        },
      },
      latencyMs: 0,
    };
  }

  // 3. Build proxy request from the *validated* URL. Using the
  // WHATWG-parsed value (not the raw input) means downstream
  // `fetch()` always sees a normalised, same-origin target — no
  // chance of re-introducing a traversal bypass by concatenating
  // strings after validation.
  const url = proxyUrl.toString();

  // Mint a short-lived HMAC-signed token that names this specific
  // api key + firm. The public API middleware verifies the signature
  // and loads the key by id (no bcrypt), so the raw key never has to
  // travel. Secret comes from the same env the session JWT uses —
  // no new env var to provision.
  const playgroundToken = createPlaygroundToken(
    { apiKeyId: apiKey.id, firmId: ctx.firm.id },
    getAuthConfig().jwtSecret,
    ctx.now,
  );

  const proxyHeaders: Record<string, string> = {
    [PLAYGROUND_TOKEN_HEADER]: playgroundToken,
    accept: 'application/json',
  };

  // Forward user-provided headers (filtered).
  //
  // Drop anything the user tried to put in a blocked slot (api-key
  // / authorization / cookie / host), and defensively reject values
  // that contain control characters. The WHATWG `fetch` already
  // rejects CRLF in header values, but a client-side bypass could
  // still cause a confusing server-side stack trace — surface a
  // clean 400 instead.
  if (input.headers !== undefined) {
    for (const [key, value] of Object.entries(input.headers)) {
      const lower = key.toLowerCase();
      if (BLOCKED_HEADERS.has(lower)) continue;
      if (HEADER_CTRL_CHAR_REGEX.test(value) || HEADER_CTRL_CHAR_REGEX.test(key)) {
        return {
          status: 400,
          statusText: 'Bad Request',
          headers: {},
          body: {
            error: {
              code: 'invalid_header',
              message: `Header "${key}" contains control characters.`,
            },
          },
          latencyMs: 0,
        };
      }
      proxyHeaders[lower] = value;
    }
  }

  let bodyStr: string | undefined;
  if (input.body !== undefined && input.method !== 'GET') {
    bodyStr = JSON.stringify(input.body);
    if (new TextEncoder().encode(bodyStr).byteLength > MAX_BODY_BYTES) {
      return {
        status: 413,
        statusText: 'Payload Too Large',
        headers: {},
        body: {
          error: {
            code: 'payload_too_large',
            message: `Request body exceeds ${MAX_BODY_BYTES} bytes.`,
          },
        },
        latencyMs: 0,
      };
    }
    proxyHeaders['content-type'] = 'application/json';
  }

  // 4. Execute proxied request
  const fetchFn = deps.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  const start = performance.now();
  let proxyRes: Response;
  try {
    proxyRes = await fetchFn(url, {
      method: input.method,
      headers: proxyHeaders,
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Math.round(performance.now() - start);
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? 'Request timed out.'
        : 'Network error during proxy request.';
    return {
      status: 502,
      statusText: 'Bad Gateway',
      headers: {},
      body: { error: { code: 'proxy_error', message } },
      latencyMs: elapsed,
    };
  }
  clearTimeout(timer);
  const elapsed = Math.round(performance.now() - start);

  // 5. Read response
  const responseHeaders: Record<string, string> = {};
  proxyRes.headers.forEach((value, key) => {
    // Only forward safe response headers
    const lower = key.toLowerCase();
    if (
      lower.startsWith('x-ratelimit') ||
      lower.startsWith('x-quota') ||
      lower.startsWith('x-request-id') ||
      lower === 'content-type' ||
      lower === 'retry-after'
    ) {
      responseHeaders[lower] = value;
    }
  });

  // Read the response with a hard byte cap. A rogue / buggy v1
  // endpoint returning multi-megabyte output would otherwise have
  // the dashboard process buffer everything into memory before we
  // could decide whether to truncate. Stream the body through the
  // response reader and bail when we cross the limit.
  const bodyRead = await readCappedText(proxyRes, MAX_RESPONSE_BYTES);
  let responseBody: unknown;
  if (bodyRead.truncated) {
    responseBody = {
      error: {
        code: 'response_too_large',
        message: `Upstream response exceeded ${MAX_RESPONSE_BYTES} bytes; body truncated.`,
      },
      truncatedPreview: bodyRead.text.slice(0, 2048),
    };
  } else {
    try {
      responseBody = bodyRead.text.length > 0 ? JSON.parse(bodyRead.text) : null;
    } catch {
      responseBody = null;
    }
  }

  return {
    status: proxyRes.status,
    statusText: proxyRes.statusText,
    headers: responseHeaders,
    body: responseBody,
    latencyMs: elapsed,
  };
}

/**
 * Stream-decode the response body, stopping as soon as the cumulative
 * decoded size hits `maxBytes`. Returning the already-decoded portion
 * lets the handler surface a helpful preview instead of an opaque
 * "body truncated" message.
 */
async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) {
    return { text: '', truncated: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Decode whatever portion fits under the cap, then abort.
        const remaining = maxBytes - (total - value.byteLength);
        if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: false });
        await reader.cancel().catch(() => undefined);
        return { text, truncated: true };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { text, truncated: false };
  } finally {
    reader.releaseLock();
  }
}
