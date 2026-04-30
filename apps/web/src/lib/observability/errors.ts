/**
 * Observability error types.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const OBSERVABILITY_ERROR_CODES = [
  'invalid_config',
  'metrics_registration_failed',
  'logger_initialization_failed',
  'tracer_initialization_failed',
  'unexpected',
] as const;

export type ObservabilityErrorCode = (typeof OBSERVABILITY_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ObservabilityError extends Error {
  readonly code: ObservabilityErrorCode;
  readonly context: Record<string, unknown> | undefined;

  constructor(code: ObservabilityErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'ObservabilityError';
    this.code = code;
    this.context = context !== undefined ? Object.freeze({ ...context }) : undefined;
    Object.freeze(this);
  }

  static wrap(code: ObservabilityErrorCode, cause: unknown): ObservabilityError {
    if (cause instanceof ObservabilityError) return cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    return new ObservabilityError(code, message, { originalError: message });
  }
}

export function isObservabilityError(value: unknown): value is ObservabilityError {
  return value instanceof ObservabilityError;
}
