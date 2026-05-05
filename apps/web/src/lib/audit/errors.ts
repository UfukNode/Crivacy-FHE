/**
 * Error taxonomy for the audit log writer.
 *
 * The audit module never reaches the network boundary directly — a
 * route handler catches these errors and translates them into the
 * OpenAPI `ApiErrorBody` shape (HTTP 500 for writer failures, HTTP
 * 400 for validation failures on the query path). The codes here are
 * intentionally narrow so we can assert specific branches in tests.
 *
 * `unexpected` is reserved for programmer errors — we never promote a
 * driver-level error to `unexpected` silently; the original error
 * should be logged and the code set to a semantically meaningful one
 * whenever possible.
 */

export type AuditErrorCode =
  | 'invalid_actor'
  | 'invalid_target'
  | 'invalid_action'
  | 'invalid_meta'
  | 'invalid_context'
  | 'meta_too_large'
  | 'batch_too_large'
  | 'batch_empty'
  | 'write_failed'
  | 'read_failed'
  | 'invalid_cursor'
  | 'invalid_range'
  | 'invalid_chain_seed'
  | 'chain_broken'
  | 'unexpected';

/**
 * Audit module error. Subclasses `Error` with a stable `name` so
 * callers can narrow by `err.name === 'AuditError'` and still receive
 * the strong code / cause chain.
 *
 * `cause` is standard ES2022 — we pass the original driver or Zod
 * error through for the observability pipeline. `context` is a free
 * shape keyed to the failing call site so the `pino` child logger can
 * attach it to the error log line.
 */
export class AuditError extends Error {
  override readonly name = 'AuditError';
  readonly code: AuditErrorCode;
  readonly context?: Readonly<Record<string, unknown>>;

  constructor(
    code: AuditErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly context?: Readonly<Record<string, unknown>>;
    },
  ) {
    super(message);
    this.code = code;
    if (options?.cause !== undefined) {
      // ES2022: Error.cause
      (this as { cause?: unknown }).cause = options.cause;
    }
    if (options?.context !== undefined) {
      this.context = options.context;
    }
    // Make the error appear correctly under V8 stack traces even
    // when subclassed across modules (Node transpilation quirks).
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Wrap an unknown driver/runtime error into an `AuditError` with
   * the given code, preserving the original error as `cause`. If the
   * input is already an `AuditError`, it is returned unchanged so the
   * first writer in the call chain wins.
   */
  static wrap(
    code: AuditErrorCode,
    message: string,
    cause: unknown,
    context?: Readonly<Record<string, unknown>>,
  ): AuditError {
    if (cause instanceof AuditError) {
      return cause;
    }
    return new AuditError(code, message, { cause, ...(context ? { context } : {}) });
  }
}

/**
 * Type guard used by the route-layer error mapper. Keeping this in
 * the same module as `AuditError` means a single import covers both.
 */
export function isAuditError(value: unknown): value is AuditError {
  return value instanceof AuditError;
}
