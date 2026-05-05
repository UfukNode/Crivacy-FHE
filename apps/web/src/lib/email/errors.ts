/**
 * Email error classes.
 *
 * @module
 */

export class EmailError extends Error {
  public readonly code: EmailErrorCode;

  constructor(
    message: string,
    code: EmailErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EmailError';
    this.code = code;
  }
}

export type EmailErrorCode =
  | 'RATE_LIMITED'
  | 'SMTP_CONNECTION_FAILED'
  | 'SMTP_AUTH_FAILED'
  | 'SMTP_SEND_FAILED'
  | 'INVALID_RECIPIENT'
  | 'TEMPLATE_ERROR'
  | 'QUEUE_ERROR';
