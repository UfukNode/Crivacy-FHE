/**
 * Webhook delivery error hierarchy.
 *
 * Single error class (`WebhookError`) with a discriminated `code` field.
 * Follows the same pattern as `AuthError`, `FheError`, `DiditError`,
 * `AuditError`, `RateLimitError`.
 *
 * @module
 */

export const WEBHOOK_ERROR_CODES = [
  'invalid_config',
  'delivery_failed',
  'delivery_timeout',
  'invalid_signature_input',
  'invalid_envelope',
  'invalid_endpoint',
  'invalid_event',
  'invalid_delivery',
  'circuit_breaker_open',
  'endpoint_disabled',
  'max_attempts_exceeded',
  'invalid_retry_schedule',
  'fan_out_failed',
  'queue_error',
  'decrypt_failed',
  'unexpected',
] as const;

export type WebhookErrorCode = (typeof WEBHOOK_ERROR_CODES)[number];

export class WebhookError extends Error {
  override readonly name = 'WebhookError';
  readonly code: WebhookErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(
    code: WebhookErrorCode,
    message: string,
    opts?: { cause?: unknown; context?: Record<string, unknown> },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.code = code;
    if (opts?.context !== undefined) {
      this.context = opts.context;
    }
  }

  /**
   * Wrap an unknown value into a `WebhookError`. If `value` is already
   * a `WebhookError` it is returned as-is (idempotent).
   */
  static wrap(
    code: WebhookErrorCode,
    value: unknown,
    context?: Record<string, unknown>,
  ): WebhookError {
    if (isWebhookError(value)) return value;
    const message = value instanceof Error ? value.message : String(value);
    const opts: { cause: unknown; context?: Record<string, unknown> } = { cause: value };
    if (context !== undefined) {
      opts.context = context;
    }
    return new WebhookError(code, message, opts);
  }
}

export function isWebhookError(value: unknown): value is WebhookError {
  return value instanceof WebhookError;
}

export function isWebhookErrorWithCode<C extends WebhookErrorCode>(
  value: unknown,
  code: C,
): value is WebhookError & { code: C } {
  return isWebhookError(value) && value.code === code;
}
