'use client';

import useSWR from 'swr';

/**
 * Audience-aware TOTP enrollment lookup. Single source of truth for
 * "does this user have an authenticator app set up?" — consumed by the
 * destructive-reauth modal to gate its 6-digit input behind a setup CTA
 * for users who have not enrolled yet (rather than echoing a backend
 * `totp_not_enrolled` 401 after an empty submit).
 *
 * Customer audience is intentionally absent: customers cannot enroll
 * TOTP at all, so the calling surface uses the password-only
 * `<CustomerReauthActionDialog>` instead of `<DestructiveReauthModal>`.
 */
export type ReauthAudience = 'admin' | 'firm';

export interface TotpEnrollmentStatus {
  readonly enrolled: boolean;
  readonly enrolledAt: string | null;
  readonly recoveryCodesRemaining: number;
}

const STATUS_ENDPOINT: Readonly<Record<ReauthAudience, string>> = {
  admin: '/api/internal/admin/profile/totp/status',
  firm: '/api/internal/profile/totp/status',
};

/**
 * URL where the audience can enroll a new authenticator app. The
 * destructive-reauth modal links here when the user hits a TOTP-required
 * action without an enrollment on file.
 */
const SETUP_PAGE: Readonly<Record<ReauthAudience, string>> = {
  admin: '/admin/settings/security',
  firm: '/dashboard/settings/security',
};

export function getTotpSetupHref(audience: ReauthAudience): string {
  return SETUP_PAGE[audience];
}

export function useTotpEnrollmentStatus(audience: ReauthAudience | null): {
  readonly status: TotpEnrollmentStatus | null;
  readonly isLoading: boolean;
  readonly error: Error | null;
} {
  const { data, error, isLoading } = useSWR<TotpEnrollmentStatus>(
    audience !== null ? STATUS_ENDPOINT[audience] : null,
  );

  return {
    status: data ?? null,
    isLoading,
    error: (error as Error | undefined) ?? null,
  } as const;
}
