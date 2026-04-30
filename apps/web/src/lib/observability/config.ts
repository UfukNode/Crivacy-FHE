/**
 * Observability configuration — Zod-parsed frozen singleton.
 *
 * Reads from environment:
 *   - LOG_LEVEL (default: info)
 *   - OTEL_ENABLED (default: false — disabled in development)
 *   - OTEL_SERVICE_NAME (default: crivacy-api)
 *   - OTEL_EXPORTER_OTLP_ENDPOINT (default: http://localhost:4317)
 *   - METRICS_ENABLED (default: true)
 *   - METRICS_PREFIX (default: crivacy_)
 *   - NODE_ENV (for pretty-print toggle)
 *
 * @module
 */

import { z } from 'zod';

import { ObservabilityError } from './errors';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

const ObservabilityConfigSchema = z
  .object({
    logLevel: z.enum(LOG_LEVELS).default('info').describe('Pino log level'),
    prettyPrint: z.boolean().default(false).describe('Human-readable logs in development'),
    otelEnabled: z.boolean().default(false).describe('Enable OpenTelemetry tracing'),
    otelServiceName: z
      .string()
      .min(1)
      .max(128)
      .default('crivacy-api')
      .describe('OTel service name'),
    otelExporterEndpoint: z
      .string()
      .url()
      .default('http://localhost:4317')
      .describe('OTel OTLP gRPC endpoint'),
    metricsEnabled: z.boolean().default(true).describe('Enable prom-client metrics'),
    metricsPrefix: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z_]+$/, 'Metrics prefix must be lowercase alphanumeric + underscore')
      .default('crivacy_')
      .describe('Prometheus metric name prefix'),
  })
  .strict()
  .readonly();

export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let cachedConfig: ObservabilityConfig | null = null;

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  return value === 'true' || value === '1';
}

export function loadObservabilityConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ObservabilityConfig {
  const nodeEnv = env['NODE_ENV'] ?? 'production';
  const isDev = nodeEnv === 'development';

  const result = ObservabilityConfigSchema.safeParse({
    logLevel: env['LOG_LEVEL'] ?? 'info',
    prettyPrint: isDev,
    otelEnabled: parseBoolean(env['OTEL_ENABLED'], false),
    otelServiceName: env['OTEL_SERVICE_NAME'] ?? 'crivacy-api',
    otelExporterEndpoint: env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4317',
    metricsEnabled: parseBoolean(env['METRICS_ENABLED'], true),
    metricsPrefix: env['METRICS_PREFIX'] ?? 'crivacy_',
  });

  if (!result.success) {
    throw new ObservabilityError('invalid_config', 'Invalid observability config', {
      issues: result.error.issues,
    });
  }

  return Object.freeze(result.data);
}

export function getObservabilityConfig(): ObservabilityConfig {
  if (cachedConfig === null) {
    cachedConfig = loadObservabilityConfig();
  }
  return cachedConfig;
}

export function resetObservabilityConfigForTests(): void {
  cachedConfig = null;
}
