'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LoadingButton } from '@/components/shared/loading-button';
import { PasswordInput } from '@/components/shared/password-input';
import { FormField } from '@/components/shared/form-field';

export interface ReauthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with password. Should throw on failure. */
  onVerify: (password: string) => Promise<void>;
  /** Called after successful verification */
  onSuccess: () => void;
}

/**
 * Re-authentication dialog for sensitive actions.
 * User must re-enter password before: change email, delete API key, revoke credential, etc.
 * 3 failed attempts → 30s lockout.
 */
export function ReauthDialog({ open, onOpenChange, onVerify, onSuccess }: ReauthDialogProps) {
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [attempts, setAttempts] = React.useState(0);
  const [lockedUntil, setLockedUntil] = React.useState<number | null>(null);
  const [countdown, setCountdown] = React.useState(0);

  // Countdown timer for lockout
  React.useEffect(() => {
    if (!lockedUntil) return;
    const interval = setInterval(() => {
      const remaining = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (remaining <= 0) {
        setLockedUntil(null);
        setCountdown(0);
        setAttempts(0);
      } else {
        setCountdown(remaining);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [lockedUntil]);

  // Reset on close
  React.useEffect(() => {
    if (!open) {
      setPassword('');
      setError('');
      setLoading(false);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lockedUntil) return;
    if (!password.trim()) {
      setError('Password is required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await onVerify(password);
      setPassword('');
      setAttempts(0);
      onOpenChange(false);
      onSuccess();
    } catch {
      const newAttempts = attempts + 1;
      setAttempts(newAttempts);

      if (newAttempts >= 3) {
        setLockedUntil(Date.now() + 30000);
        setCountdown(30);
        setError('Too many attempts. Try again in 30 seconds.');
      } else {
        setError(`Incorrect password. ${3 - newAttempts} attempt(s) remaining.`);
      }
    } finally {
      setLoading(false);
    }
  };

  const isLocked = lockedUntil !== null && Date.now() < lockedUntil;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form noValidate onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Confirm your identity</DialogTitle>
            <DialogDescription>
              Enter your password to continue with this action.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <FormField
              label="Current password"
              htmlFor="reauth-password"
              error={error}
              required
            >
              <PasswordInput
                id="reauth-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading || isLocked}
                autoFocus
                autoComplete="current-password"
                aria-describedby={error ? 'reauth-password-error' : undefined}
              />
            </FormField>
            {isLocked && countdown > 0 && (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Try again in {countdown}s
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
            <LoadingButton type="submit" loading={loading} disabled={isLocked}>
              Confirm
            </LoadingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
