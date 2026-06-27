// @vitest-environment jsdom
/**
 * Branch coverage for the destructive-reauth modal's TOTP-enrollment
 * gate. The 3 render branches mirror the backend reauth gate's reality:
 *
 *   1. Status fetch in flight — neither inputs nor CTA shown yet.
 *   2. Caller has no TOTP enrolled — the form is replaced by a setup
 *      CTA pointing at the audience-specific security settings page.
 *      This is the load-bearing branch: without it, the user submits
 *      a 6-digit code that the backend rejects with `totp_not_enrolled`,
 *      a confusing UX for an account that simply has not enrolled yet.
 *   3. Caller has TOTP enrolled — the standard `currentPassword +
 *      totpCode` form renders and the existing submit path is
 *      unchanged.
 *
 * SWR is mocked at the module boundary so each branch can be driven
 * deterministically without standing up a fetch shim. The component is
 * mounted via `React.createElement` rather than JSX so the file doesn't
 * depend on the project's JSX runtime config — the only other `.tsx`
 * test in this repo (`smoke.test.tsx`) sidesteps JSX entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { render, screen } from '@testing-library/react';

import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';

type StatusShape = {
  enrolled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
};

type SwrFakeReturn = {
  data: StatusShape | undefined;
  error: undefined;
  isLoading: boolean;
};

const swrSpy = vi.fn<(key: unknown) => SwrFakeReturn>();

vi.mock('swr', () => ({
  __esModule: true,
  default: (key: unknown) => swrSpy(key),
}));

const baseProps = {
  open: true,
  onOpenChange: () => undefined,
  title: 'Reset KYC',
  description: 'Revoke credentials and clear KYC level.',
  confirmLabel: 'Reset KYC',
  onConfirm: async () => undefined,
} as const;

function mount(
  overrides: Partial<React.ComponentProps<typeof DestructiveReauthModal>>,
): void {
  render(
    React.createElement(DestructiveReauthModal, {
      ...baseProps,
      audience: 'admin',
      ...overrides,
    }),
  );
}

beforeEach(() => {
  swrSpy.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('DestructiveReauthModal — TOTP enrollment branches', () => {
  it('renders the loading branch while the status fetch is in flight', () => {
    swrSpy.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: true,
    });

    mount({ audience: 'admin' });

    expect(screen.getByText('Checking authenticator…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Authenticator code')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /set up authenticator/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the setup CTA when the admin has not enrolled TOTP', () => {
    swrSpy.mockReturnValue({
      data: { enrolled: false, enrolledAt: null, recoveryCodesRemaining: 0 },
      error: undefined,
      isLoading: false,
    });

    mount({ audience: 'admin' });

    expect(screen.getByText('Authenticator app required')).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /set up authenticator/i });
    expect(cta).toHaveAttribute('href', '/admin/settings/security');

    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Authenticator code')).not.toBeInTheDocument();
  });

  it('points the firm CTA at the dashboard security page', () => {
    swrSpy.mockReturnValue({
      data: { enrolled: false, enrolledAt: null, recoveryCodesRemaining: 0 },
      error: undefined,
      isLoading: false,
    });

    mount({ audience: 'firm' });

    const cta = screen.getByRole('link', { name: /set up authenticator/i });
    expect(cta).toHaveAttribute('href', '/dashboard/settings/security');
  });

  it('renders the standard form when TOTP is enrolled', () => {
    swrSpy.mockReturnValue({
      data: {
        enrolled: true,
        enrolledAt: '2026-01-01T00:00:00Z',
        recoveryCodesRemaining: 8,
      },
      error: undefined,
      isLoading: false,
    });

    mount({ audience: 'admin' });

    expect(screen.getByLabelText(/current password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/authenticator code/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /set up authenticator/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Authenticator app required'),
    ).not.toBeInTheDocument();
  });

  it('skips the SWR fetch while the dialog is closed', () => {
    swrSpy.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
    });

    mount({ open: false, audience: 'admin' });

    const lastCall = swrSpy.mock.calls.at(-1);
    expect(lastCall?.[0]).toBeNull();
  });
});
