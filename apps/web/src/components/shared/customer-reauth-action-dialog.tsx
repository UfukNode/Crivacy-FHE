'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/components/shared/form-field';
import { LoadingButton } from '@/components/shared/loading-button';
import { PasswordInput } from '@/components/shared/password-input';

export interface CustomerReauthActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Header copy, caller-provided per action. */
  title: string;
  /** Body copy describing the action's blast radius. */
  description: string;
  /** Submit button label (e.g. "Link wallet", "Unlink Google"). */
  confirmLabel: string;
  /**
   * Whether the action removes a sign-in method (red button) or adds
   * one (neutral button). Linking a wallet/Google is neutral; unlinking
   * a sign-in method is destructive.
   */
  destructive?: boolean;
  /**
   * Caller-provided runner. Receives the verified password, runs the
   * actual mutation (which may include extension-mediated steps like
   * wallet signing). Should `throw new Error(message)` with a
   * user-facing string on backend rejection, the modal renders the
   * message inline and stays open so the user can retry. On success
   * the modal closes itself.
   */
  onConfirm: (currentPassword: string) => Promise<void>;
}

/**
 * Password-only reauth dialog for customer-side credential mutations
 * (wallet link/unlink, Google unlink). Customer audience does not
 * have TOTP enrolled, so this is the customer analog of
 * {@link DestructiveReauthModal} (firm/admin variant which adds a
 * 6-digit TOTP gate).
 *
 * Replaces three legacy `window.prompt` callsites in the customer
 * security page. Backend reauth is enforced regardless of the UI used
 * (`reauthGate` in `/api/customer/auth/{wallet,google}/{link,unlink}`);
 * this component simply surfaces the gate properly so a wallet-only
 * user without a password sees a helpful inline error rather than a
 * post-hoc toast after a wasted wallet-signing round-trip.
 */
export function CustomerReauthActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
}: CustomerReauthActionDialogProps) {
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setPassword('');
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

    setLoading(true);
    try {
      await onConfirm(password);
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form noValidate onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <FormField
              label="Current password"
              htmlFor="customer-reauth-action-password"
              required
            >
              <PasswordInput
                id="customer-reauth-action-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                autoFocus
                autoComplete="current-password"
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
      </DialogContent>
    </Dialog>
  );
}
