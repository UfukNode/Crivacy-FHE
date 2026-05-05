/**
 * Email system — barrel export.
 *
 * @module
 */

export { emailConfigSchema, buildEmailConfig, tryBuildEmailConfig, type EmailConfig } from './config';
export { getTransporter, closeTransporter } from './client';
export {
  verificationEmail,
  passwordResetEmail,
  welcomeEmail,
  ticketUpdateEmail,
  newLoginAlertEmail,
  accountStatusChangeEmail,
  type AccountStatusAction,
  type EmailContent,
} from './templates';
export { checkEmailRateLimit, recordEmailSent, type EmailType, type RateLimitResult } from './rate-limit';
export { enqueueEmail, EMAIL_SEND_QUEUE, type EmailSendJob } from './send';
export { EmailError, type EmailErrorCode } from './errors';
export { enqueueEmailFromRoute } from './enqueue-from-route';
