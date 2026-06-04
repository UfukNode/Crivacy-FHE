/**
 * Shared security UI primitives used by every audience's settings
 * surface (customer / firm / admin) plus the accept-invite flow.
 * Keeping these in one place means visual + behavioural drift across
 * audiences is impossible, edits land everywhere at once.
 */

export { ChangePasswordForm } from './change-password-form';
export type { ChangePasswordFormProps } from './change-password-form';

export { RecoveryCodeReveal } from './recovery-code-reveal';
export type {
  RecoveryCodeDownloadContext,
  RecoveryCodeRevealProps,
} from './recovery-code-reveal';

export { TotpEnrollmentInstructions } from './totp-enrollment-instructions';

export { TotpManagementPanel } from './totp-management-panel';
export type {
  TotpManagementPanelProps,
  TotpPanelEndpoints,
} from './totp-management-panel';
