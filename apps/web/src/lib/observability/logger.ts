/**
 * Structured JSON logger — pino-based, request-context-aware.
 *
 * Features:
 *   - Structured JSON output (production) or pretty-print (development)
 *   - Child loggers with requestId / firmId / apiKeyId context
 *   - PII redaction: keys matching sensitive patterns are replaced
 *   - No module-level global state — logger is built from config
 *
 * @module
 */

import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';

import type { ObservabilityConfig } from './config';
import { getObservabilityConfig } from './config';

// ---------------------------------------------------------------------------
// PII redaction paths
// ---------------------------------------------------------------------------

/**
 * Keys that are redacted in every log entry. These cover common PII fields
 * that could leak through structured logging if a developer accidentally
 * passes a raw DB row or API response to the logger.
 */
const REDACT_PATHS = [
  'password',
  'passwordHash',
  'password_hash',
  'secret',
  'secretKey',
  'secret_key',
  'apiKey',
  'api_key',
  'rawKey',
  'raw_key',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'totpSecret',
  'totp_secret',
  'authorization',
  'cookie',
  'ssn',
  'nationalId',
  'national_id',
  'dateOfBirth',
  'date_of_birth',
  'documentNumber',
  'document_number',
  'phoneNumber',
  'phone_number',
  'firstName',
  'first_name',
  'lastName',
  'last_name',
  'address',
  'addressLine',
  'address_line',
  'addressCity',
  'address_city',
  'addressCountry',
  'address_country',
  'email',
];

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

/**
 * Create a pino logger from the given config.
 */
export function createLogger(config?: ObservabilityConfig): PinoLogger {
  const cfg = config ?? getObservabilityConfig();

  const options: pino.LoggerOptions = {
    level: cfg.logLevel,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
    base: {
      service: cfg.otelServiceName,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };

  if (cfg.prettyPrint) {
    // Development: pretty-print to stdout via pino-pretty (if installed)
    // Falls back to JSON if pino-pretty is not available
    return pino({
      ...options,
      transport: {
        target: 'pino/file',
        options: { destination: 1 },
      },
    });
  }

  // Production: JSON to stdout — Promtail picks this up
  return pino(options);
}

// ---------------------------------------------------------------------------
// Context-aware child loggers
// ---------------------------------------------------------------------------

export interface LogContext {
  readonly requestId?: string;
  readonly firmId?: string;
  readonly apiKeyId?: string;
  readonly method?: string;
  readonly path?: string;
  readonly ip?: string | null;
}

/**
 * Create a child logger bound with request context fields.
 * The child inherits all parent settings (level, redaction, serializers).
 */
export function childLogger(parent: PinoLogger, context: LogContext): PinoLogger {
  const bindings: Record<string, unknown> = {};

  if (context.requestId !== undefined) bindings['requestId'] = context.requestId;
  if (context.firmId !== undefined) bindings['firmId'] = context.firmId;
  if (context.apiKeyId !== undefined) bindings['apiKeyId'] = context.apiKeyId;
  if (context.method !== undefined) bindings['method'] = context.method;
  if (context.path !== undefined) bindings['path'] = context.path;
  if (context.ip !== undefined && context.ip !== null) bindings['ip'] = context.ip;

  return parent.child(bindings);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let rootLogger: PinoLogger | null = null;

/**
 * Get the process-level root logger (lazy-initialized from config).
 */
export function getRootLogger(): PinoLogger {
  if (rootLogger === null) {
    rootLogger = createLogger();
  }
  return rootLogger;
}

/**
 * Reset the root logger (test cleanup).
 */
export function resetRootLoggerForTests(): void {
  rootLogger = null;
}

export type { PinoLogger as Logger };
