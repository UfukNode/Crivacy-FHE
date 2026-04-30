/**
 * OpenTelemetry tracing — SDK setup with OTLP gRPC exporter.
 *
 * When `OTEL_ENABLED=true`, this module initializes the OTel Node SDK
 * with a BatchSpanProcessor exporting to the configured endpoint (Tempo).
 *
 * When disabled (default in dev), all tracing calls are no-ops via the
 * OTel API's default NoopTracer.
 *
 * @module
 */

import { type Span, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';

import type { ObservabilityConfig } from './config';
import { getObservabilityConfig } from './config';

// ---------------------------------------------------------------------------
// SDK initialization (lazy, one-time)
// ---------------------------------------------------------------------------

let sdkInitialized = false;

/**
 * Query-string parameters whose values must never land in an OTel
 * span or any downstream trace/log sink. Match is case-insensitive
 * and applied whole-key (no substring) so an innocent
 * `?category_token=foo` would NOT be scrubbed — list the exact keys
 * that carry secrets.
 */
const SENSITIVE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'token',
  'code',
  'secret',
  'access_token',
  'refresh_token',
  'signature',
  'password',
]);

function redactSensitiveQueryParams(url: string): string {
  try {
    // Relative URLs are legal in `http.target` attributes; give
    // `URL` a base so parsing doesn't throw.
    const parsed = new URL(url, 'http://redact.local');
    let mutated = false;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[REDACTED]');
        mutated = true;
      }
    }
    if (!mutated) return url;
    // Reconstruct while preserving whether the original was
    // absolute or relative.
    return url.startsWith('/')
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.toString();
  } catch {
    return url;
  }
}

function stripOrigin(url: string): string {
  try {
    const parsed = new URL(url, 'http://redact.local');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

/**
 * Initialize the OTel SDK if enabled. Idempotent.
 *
 * Must be called early in the application lifecycle (before any
 * instrumented code runs). In Next.js, this is called from
 * `instrumentation.ts`.
 */
export async function initTracing(config?: ObservabilityConfig): Promise<void> {
  if (sdkInitialized) return;
  const cfg = config ?? getObservabilityConfig();
  if (!cfg.otelEnabled) {
    sdkInitialized = true;
    return;
  }

  // Dynamic imports to avoid loading heavy gRPC deps when tracing is off
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
    '@opentelemetry/semantic-conventions'
  );
  const { HttpInstrumentation } = await import('@opentelemetry/instrumentation-http');

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: cfg.otelServiceName,
    [ATTR_SERVICE_VERSION]: process.env['npm_package_version'] ?? '0.0.0',
    'deployment.environment': process.env['NODE_ENV'] ?? 'production',
  });

  const traceExporter = new OTLPTraceExporter({
    url: cfg.otelExporterEndpoint,
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [
      new HttpInstrumentation({
        // Scrub sensitive query params out of the captured span
        // attributes before the exporter sees them. The token lives
        // in URL fragments now, so the primary target is legacy
        // `?token=` links still in flight during the 72h TTL — plus
        // any other one-time-use params we accidentally leak.
        //
        // Fragments are never transmitted, so OTel cannot observe
        // them; this is purely belt-and-suspenders for the query
        // string surface.
        requestHook: (span, request) => {
          const rawUrl = 'url' in request && typeof request.url === 'string' ? request.url : null;
          if (rawUrl === null) return;
          const redacted = redactSensitiveQueryParams(rawUrl);
          if (redacted !== rawUrl) {
            span.setAttribute('http.url', redacted);
            span.setAttribute('http.target', stripOrigin(redacted));
          }
        },
      }),
    ],
  });

  sdk.start();
  sdkInitialized = true;

  // Graceful shutdown
  const shutdown = async () => {
    await sdk.shutdown();
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

// ---------------------------------------------------------------------------
// Tracer helpers
// ---------------------------------------------------------------------------

const TRACER_NAME = 'crivacy-api';

/**
 * Get the application tracer. Returns a NoopTracer if OTel is disabled.
 */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Start a span, run the callback, and end the span. Handles errors by
 * setting span status to ERROR and re-throwing.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Synchronous version of withSpan for non-async operations.
 */
export function withSpanSync<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => T,
): T {
  const tracer = getTracer();
  const span = tracer.startSpan(name, { attributes });
  try {
    const result = fn(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    span.end();
  }
}

// ---------------------------------------------------------------------------
// Reset for tests
// ---------------------------------------------------------------------------

export function resetTracingForTests(): void {
  sdkInitialized = false;
}
