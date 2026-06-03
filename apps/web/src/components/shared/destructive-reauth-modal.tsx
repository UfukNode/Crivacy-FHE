'use client';

import * as React from 'react';
import Link from 'next/link';
import { Loader2, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/shared/form-field';
import { LoadingButton } from '@/components/shared/loading-button';
import { PasswordInput } from '@/components/shared/password-input';
import {
  getTotpSetupHref,
  useTotpEnrollmentStatus,
  type ReauthAudience,
} from '@/hooks/use-totp-enrollment-status';

export interface DestructiveReauthEnvelope {
  readonly currentPassword: string;
  readonly totpCode: string;
}

export interface DestructiveReauthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Audience tunes the dialog copy/icon and selects which TOTP status
   * endpoint + setup page the modal links to. The reauth contract is
   * identical across firm + admin (password + 6-digit TOTP). Customer
   * audience does not use this, those flows have no TOTP enroll path;
   * see `<ReauthDialog>` for the password-only variant.
   */
  audience: ReauthAudience;
  /** Title shown in the dialog header. Caller-provided per action. */
  title: string;
  /** Body copy describing the action's blast radius. */
  description: string;
  /** Submit button label (e.g. "Ban customer", "Create webhook"). */
  confirmLabel: string;
  /** Whether the action is destructive (red button) or neutral. */
  destructive?: boolean;
  /**
   * Caller-provided handler. Receives the verified envelope, runs
   * the actual mutation. Should `throw new Error(message)` with a
   * user-facing string on backend rejection, the modal renders the
   * message inline and stays open so the user can retry.
   *
   * On success the modal closes itself via `onOpenChange(false)`.
   */
  onConfirm: (envelope: DestructiveReauthEnvelope) => Promise<void>;
}

/**
 * Two-factor reauth dialog for destructive operations on TOTP-enrolled
 * audiences (firm + admin). Mirrors the backend `requireTotpReauth`
 * envelope shape; the security model is identical regardless of
 * audience prop. Used by 23 destructive endpoints, never inline a
 * `window.prompt` for password-only on these flows.
 *
 * Renders one of three branches based on the caller's TOTP enrollment
 * status (read from the audience-specific `/profile/totp/status`
 * endpoint when the dialog opens):
 *
 *   1. Loading, short skeleton while the status fetch is in flight.
 *   2. Not enrolled, replaces the form with a "Set up authenticator"
 *      CTA pointing at the security settings page. The backend gate
 *      would reject any submit with `totp_not_enrolled` anyway, so
 *      hiding the inputs prevents the user from typing a code that
 *      cannot succeed and steers them to the one action that can.
 *   3. Enrolled, the standard `currentPassword + totpCode` form.
 *
 * The backend reauth gate (`requireTotpReauth`) is unchanged; this is
 * a pure UX-parity fix for the case where the security model demands
 * a factor the caller has not configured yet.
 */
export function DestructiveReauthModal({
  open,
  onOpenChange,
  audience,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
}: DestructiveReauthModalProps) {
  const enrollment = useTotpEnrollmentStatus(open ? audience : null);

  const [password, setPassword] = React.useState('');
  const [totpCode, setTotpCode] = React.useState('');
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  // Reset on close so the next open is clean (no stale password
  // sitting in state, no leftover error from the previous attempt).
  React.useEffect(() => {
    if (!open) {
      setPassword('');
      setTotpCode('');
      setError('');
      setLoading(false);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.trim().length === 0) {
      setError('Current password is required.');
      return;
    }
    if (!/^\d{6}$/.test(totpCode)) {
      setError('Authenticator code must be 6 digits.');
      return;
    }

    setLoading(true);
    try {
      await onConfirm({ currentPassword: password, totpCode });
      // Caller may also call onOpenChange(false); we close defensively
      // so a forgetful caller still gets a clean modal close on success.
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const showLoadingBranch = enrollment.isLoading && enrollment.status === null;
  const showSetupCta =
    enrollment.status !== null && enrollment.status.enrolled === false;
  const setupHref = getTotpSetupHref(audience);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {showLoadingBranch ? (
          <>
            <div
              className="flex items-center gap-3 py-6 text-sm text-[var(--color-muted)]"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>Checking authenticator…</span>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : showSetupCta ? (
          <>
            <div
              role="region"
              aria-label="Authenticator required"
              className="my-2 rounded-[var(--radius-md)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-4"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-warning)]/20 text-[var(--color-warning)]">
                  <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-[var(--color-fg)]">
                    Authenticator app required
                  </p>
                  <p className="text-xs leading-relaxed text-[var(--color-muted)]">
                    This action requires a second factor for safety. Set up an
                    authenticator app first, then return here to continue.
                  </p>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button asChild>
                <Link
                  href={setupHref}
                  onClick={() => onOpenChange(false)}
                >
                  Set up authenticator
                </Link>
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form noValidate onSubmit={handleSubmit}>
            <div className="grid gap-4 py-4">
              <FormField
                label="Current password"
                htmlFor="destructive-reauth-password"
                required
              >
                <PasswordInput
                  id="destructive-reauth-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  autoFocus
                  autoComplete="current-password"
                />
              </FormField>
              <FormField
                label="Authenticator code"
                htmlFor="destructive-reauth-totp"
                required
                description="Enter the 6-digit code from your authenticator app."
              >
                <Input
                  id="destructive-reauth-totp"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={totpCode}
                  onChange={(e) =>
                    setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  disabled={loading}
                />
              </FormField>
              {error !== '' && (
                <p
                  className="text-sm text-[var(--color-danger)]"
                  role="alert"
                  aria-live="polite"
                >
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={loading}
              >
                Cancel
              </Button>
              <LoadingButton
                type="submit"
                loading={loading}
                variant={destructive ? 'destructive' : 'default'}
              >
                {confirmLabel}
              </LoadingButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
