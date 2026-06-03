'use client';

import * as React from 'react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/shared/form-field';
import { LoadingButton } from '@/components/shared/loading-button';
import { PasswordInput } from '@/components/shared/password-input';
import { PasswordStrength, isPasswordStrong } from '@/components/shared/password-strength';

export interface ChangePasswordFormProps {
  /** POST target, `/api/customer/profile/change-password`, `/api/internal/admin/profile/change-password`, etc. */
  readonly endpoint: string;
  /** Copy for the card title + description. Defaults are audience-agnostic. */
  readonly title?: string;
  readonly description?: string;
  /** Called after a successful save (e.g. to mutate a user-info SWR). */
  readonly onChanged?: () => void;
}

/**
 * Shared change-password card used by every surface that supports
 * self-service password rotation (customer, admin). Firm currently
 * routes password changes through the forgot-password flow rather
 * than an in-app form; this component can adopt that audience later
 * without changes.
 *
 * The backend is expected to:
 *   - Reauth via `currentPassword` (wrong → 401 with a message).
 *   - Reject same-password reuse with a 400.
 *   - Reject breached (HIBP) passwords with a 400.
 *   - Revoke other sessions on success.
 *
 * This component does NOT implement any of those guards, it forwards
 * the server's error message so the UI stays a thin shell. Inline
 * validation is kept to structural strength + same-password-mismatch
 * because those keep the user out of the submit path.
 */
export function ChangePasswordForm({
  endpoint,
  title = 'Change password',
  description = 'Update your password. Other active sessions will be revoked.',
  onChanged,
}: ChangePasswordFormProps) {
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const submit = React.useCallback(async () => {
    const nextErrors: Record<string, string> = {};
    if (currentPassword.length === 0) {
      nextErrors['currentPassword'] = 'Current password is required.';
    }
    if (!isPasswordStrong(newPassword)) {
      nextErrors['newPassword'] =
        'Password must be at least 12 characters with uppercase, number, and special character.';
    }
    if (newPassword !== confirmPassword) {
      nextErrors['confirmPassword'] = 'Passwords do not match.';
    }
    if (currentPassword === newPassword && newPassword.length > 0) {
      nextErrors['newPassword'] = 'New password must be different from current password.';
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setErrors({});
    setSaving(true);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        toast.error(body?.error?.message ?? 'Failed to change password.');
        return;
      }
      toast.success('Password changed successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onChanged?.();
    } catch {
      toast.error('An unexpected error occurred.');
    } finally {
      setSaving(false);
    }
  }, [currentPassword, newPassword, confirmPassword, endpoint, onChanged]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField
          label="Current password"
          htmlFor="change-current-password"
          error={errors['currentPassword']}
          required
        >
          <PasswordInput
            id="change-current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            disabled={saving}
          />
        </FormField>
        <FormField
          label="New password"
          htmlFor="change-new-password"
          error={errors['newPassword']}
          required
        >
          <PasswordInput
            id="change-new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            disabled={saving}
          />
          <PasswordStrength password={newPassword} className="mt-2" />
        </FormField>
        <FormField
          label="Confirm new password"
          htmlFor="change-confirm-password"
          error={errors['confirmPassword']}
          required
        >
          <PasswordInput
            id="change-confirm-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            disabled={saving}
          />
        </FormField>
        <div className="flex justify-end">
          <LoadingButton loading={saving} onClick={submit} loadingText="Saving...">
            Change password
          </LoadingButton>
        </div>
      </CardContent>
    </Card>
  );
}
