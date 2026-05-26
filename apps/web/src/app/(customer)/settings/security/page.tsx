'use client';

import * as React from 'react';
import { Laptop, Smartphone, Shield, LogOut, Wallet, Link2, Unlink2, Mail, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import useSWR from 'swr';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton } from '@/components/shared/copy-button';
import { LoadingButton } from '@/components/shared/loading-button';
import { FormField } from '@/components/shared/form-field';
import { PasswordInput } from '@/components/shared/password-input';
import { PasswordStrength, isPasswordStrong } from '@/components/shared/password-strength';
import { ReauthDialog } from '@/components/shared/reauth-dialog';
import { CustomerReauthActionDialog } from '@/components/shared/customer-reauth-action-dialog';
import { ChangePasswordForm } from '@/components/shared/security';
import { useSessions } from '@/hooks/use-sessions';
import { useReauth } from '@/hooks/use-reauth';
import { EMAIL_MAX_LENGTH } from '@/lib/validation/auth';

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

interface LinkedAccountInfo {
  readonly provider: string;
  readonly email: string | null;
  readonly displayName: string | null;
}

interface MeResponse {
  readonly id: string;
  readonly email: string | null;
  readonly hasPassword: boolean;
  readonly hasEmail: boolean;
  readonly linkedAccounts: readonly LinkedAccountInfo[];
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function isMobileDevice(deviceName: string | null): boolean {
  if (deviceName === null) return false;
  const lower = deviceName.toLowerCase();
  return (
    lower.includes('mobile') ||
    lower.includes('iphone') ||
    lower.includes('android') ||
    lower.includes('ipad') ||
    lower.includes('phone')
  );
}

/* -------------------------------------------------------------------------- */
/*  Copyable address                                                          */
/* -------------------------------------------------------------------------- */

function CopyableAddress({ address }: { readonly address: string }) {
  if (!address) return null;

  // Shared copy button, AUD-CUS-UI-001 fix. Keeps icon animation,
  // success toast, and a11y label consistent with the other 13 copy
  // surfaces (api-keys, oauth-clients, totp-panel, etc.).
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-xs text-[var(--color-muted)] max-w-[180px] truncate font-mono">
        {address}
      </span>
      <CopyButton value={address} iconOnly />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Change Password Section                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Thin wrapper over the shared {@link ChangePasswordForm}. Kept as a
 * named section so the layout-level composition at the bottom reads
 * cleanly; the actual form logic is centralised in the shared primitive
 * so customer / admin (and any future audience) all show identical UX.
 */
function ChangePasswordSection() {
  return (
    <ChangePasswordForm
      endpoint="/api/customer/profile/change-password"
      description="Update your password to keep your account secure."
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Set Password Section (for wallet-only users)                              */
/* -------------------------------------------------------------------------- */

function SetPasswordSection({
  onPasswordSet,
  requiresWalletProof,
}: {
  readonly onPasswordSet: () => void;
  /**
   * `true` when the current customer has no email on file, the
   * backend gates `set-password` on a fresh wallet signature in that
   * case so a stolen session cannot silently chain
   * `set-password + add-email` into a persistent email+password
   * backdoor. The UI transparently requests a wallet signature
   * before submitting when this is true.
   */
  readonly requiresWalletProof: boolean;
}) {
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const handleSetPassword = React.useCallback(async () => {
    const newErrors: Record<string, string> = {};

    if (!isPasswordStrong(newPassword)) {
      newErrors['newPassword'] = 'Password must be at least 8 characters with uppercase, number, and special character.';
    }
    if (newPassword !== confirmPassword) {
      newErrors['confirmPassword'] = 'Passwords do not match.';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setErrors({});
    setSaving(true);
    try {
      // Email-less (wallet-only) accounts must attach a fresh wallet
      // signature to the request. For every other account we just
      // POST the password, the post-hoc "your password was set"
      // email covers the takeover-detection role.
      let walletProof: { challenge: string; message: string; signature: string } | undefined;
      if (requiresWalletProof) {
        try {
          const eth = (
            window as unknown as {
              ethereum?: {
                request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
              };
            }
          ).ethereum;
          if (eth === undefined) {
            toast.error('An EVM wallet is required to set a password on this account.');
            return;
          }

          const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
          const address = accounts[0];
          if (address === undefined) {
            toast.error('Wallet connection was rejected.');
            return;
          }

          const challengeRes = await fetch('/api/customer/auth/wallet/challenge', {
            method: 'POST',
            credentials: 'include',
          });
          if (!challengeRes.ok) {
            toast.error('Failed to request a wallet challenge. Please try again.');
            return;
          }
          const { challenge, nonce } = (await challengeRes.json()) as {
            challenge: string;
            nonce: string;
          };

          const { createSiweMessage } = await import('viem/siwe');
          const message = createSiweMessage({
            address: address as `0x${string}`,
            chainId: 11155111,
            domain: window.location.host,
            nonce,
            uri: window.location.origin,
            version: '1',
            statement: 'Prove wallet ownership to set a password on your Crivacy account.',
          });

          const signature = (await eth.request({
            method: 'personal_sign',
            params: [message, address],
          })) as string;
          if (!signature) {
            toast.error('Wallet signature was rejected.');
            return;
          }

          walletProof = { challenge, message, signature };
        } catch {
          toast.error('Wallet signing failed. Please try again.');
          return;
        }
      }

      const res = await fetch('/api/customer/profile/set-password', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: newPassword,
          ...(walletProof !== undefined ? { walletProof } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        toast.error(body?.error?.message ?? 'Failed to set password.');
        return;
      }

      toast.success('Password set successfully.');
      setNewPassword('');
      setConfirmPassword('');
      onPasswordSet();
    } catch {
      toast.error('An unexpected error occurred.');
    } finally {
      setSaving(false);
    }
  }, [newPassword, confirmPassword, onPasswordSet, requiresWalletProof]);

  return (
    <Card id="set-password-section">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5" aria-hidden="true" />
          Set password
        </CardTitle>
        <CardDescription>
          Add a password to your account so you can also sign in with email and password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField
          label="Password"
          htmlFor="security-set-password"
          error={errors['newPassword']}
          required
        >
          <PasswordInput
            id="security-set-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            disabled={saving}
          />
          <PasswordStrength password={newPassword} className="mt-2" />
        </FormField>

        <FormField
          label="Confirm password"
          htmlFor="security-set-confirm"
          error={errors['confirmPassword']}
          required
        >
          <PasswordInput
            id="security-set-confirm"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            disabled={saving}
          />
        </FormField>

        <div className="flex justify-end">
          <LoadingButton
            loading={saving}
            onClick={handleSetPassword}
            aria-label="Set password"
          >
            Set password
          </LoadingButton>
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Email Change Section                                                       */
/* -------------------------------------------------------------------------- */

type EmailChangeStep = 'display' | 'input' | 'verify';

function EmailChangeSection({ currentEmail, onEmailChanged }: {
  readonly currentEmail: string | null;
  readonly onEmailChanged: () => void;
}) {
  const [step, setStep] = React.useState<EmailChangeStep>('display');
  const [newEmail, setNewEmail] = React.useState('');
  // Reauth gate (BUG #42 fix): the change-email endpoint requires the
  // current password before issuing a verification token. Without it
  // a stolen-cookie attacker could flip the canonical login email
  // without a password challenge → password-reset takeover chain.
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [token, setToken] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleInitiate = React.useCallback(async () => {
    const trimmed = newEmail.trim().toLowerCase();
    if (trimmed.length === 0) {
      setError('Email is required.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Please enter a valid email address.');
      return;
    }
    if (currentEmail && trimmed === currentEmail.toLowerCase()) {
      setError('New email is the same as your current email.');
      return;
    }
    if (currentPassword.length === 0) {
      setError('Current password is required.');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/customer/profile/change-email', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newEmail: trimmed, currentPassword }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? 'Failed to initiate email change.');
        return;
      }

      const data = (await res.json()) as { token: string };
      setToken(data.token);
      setStep('verify');
      // Clear password from memory once the gate is past, the token
      // is enough to complete the change, no need to keep the secret
      // hanging around for the verify step.
      setCurrentPassword('');
      toast.success('Verification code sent to your new email.');
    } catch {
      setError('An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  }, [newEmail, currentPassword, currentEmail]);

  const handleVerify = React.useCallback(async () => {
    const trimmedCode = code.replace(/[\s\-]/g, '').trim();
    if (trimmedCode.length !== 6 || !/^\d{6}$/.test(trimmedCode)) {
      setError('Please enter the 6-digit code.');
      return;
    }
    if (!token) {
      setError('Session expired. Please start again.');
      setStep('input');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/customer/profile/verify-email-change', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, code: trimmedCode }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? 'Verification failed.');
        return;
      }

      toast.success('Email address updated successfully.');
      setStep('display');
      setNewEmail('');
      setCode('');
      setToken(null);
      onEmailChanged();
    } catch {
      setError('An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  }, [code, token, onEmailChanged]);

  const handleCancel = React.useCallback(() => {
    setStep('display');
    setNewEmail('');
    setCode('');
    setToken(null);
    setError(null);
  }, []);

  // No email set, handled by Connected Accounts "Add email" flow
  if (currentEmail === null) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5" aria-hidden="true" />
          Email address
        </CardTitle>
        <CardDescription>
          Change the email address associated with your account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {step === 'display' && (
          <div className="flex items-center gap-2">
            <Input
              value={currentEmail}
              disabled
              readOnly
              autoComplete="email"
              className="flex-1"
            />
            <button
              type="button"
              onClick={() => setStep('input')}
              className="flex h-9 cursor-pointer items-center gap-1.5 rounded-md px-3 text-sm text-[var(--color-accent)] hover:bg-[var(--color-surface)] transition-colors"
              aria-label="Change email address"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              Change
            </button>
          </div>
        )}

        {step === 'input' && (
          <div className="space-y-3">
            <FormField label="New email" htmlFor="security-new-email">
              <Input
                id="security-new-email"
                type="email"
                value={newEmail}
                onChange={(e) => { setNewEmail(e.target.value); setError(null); }}
                placeholder="new@example.com"
                disabled={loading}
                autoComplete="email"
                maxLength={EMAIL_MAX_LENGTH}
              />
            </FormField>
            <FormField
              label="Current password"
              htmlFor="security-change-email-pwd"
              error={error ?? undefined}
            >
              <PasswordInput
                id="security-change-email-pwd"
                value={currentPassword}
                onChange={(e) => { setCurrentPassword(e.target.value); setError(null); }}
                disabled={loading}
                autoComplete="current-password"
                onKeyDown={(e) => { if (e.key === 'Enter') void handleInitiate(); }}
              />
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Required to confirm it&apos;s you. The new email won&apos;t be saved
                until you verify it from the inbox.
              </p>
            </FormField>
            <div className="flex items-center justify-between">
              <p className="text-xs text-[var(--color-muted)]">
                Current: {currentEmail}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCancel}
                  className="cursor-pointer text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                >
                  Cancel
                </button>
                <LoadingButton size="sm" loading={loading} onClick={handleInitiate}>
                  Send code
                </LoadingButton>
              </div>
            </div>
          </div>
        )}

        {step === 'verify' && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--color-muted)]">
              A 6-digit code was sent to <strong className="text-[var(--color-fg)]">{newEmail.trim().toLowerCase()}</strong>
            </p>
            <FormField label="Verification code" htmlFor="security-email-code" error={error ?? undefined}>
              <div className="flex gap-2">
                <Input
                  id="security-email-code"
                  value={code}
                  onChange={(e) => { setCode(e.target.value); setError(null); }}
                  placeholder="000000"
                  maxLength={6}
                  disabled={loading}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  className="flex-1 font-mono tracking-widest"
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleVerify(); }}
                />
                <LoadingButton size="sm" loading={loading} onClick={handleVerify}>
                  Verify
                </LoadingButton>
              </div>
            </FormField>
            <p className="text-xs text-[var(--color-muted)]">
              <button type="button" onClick={handleCancel} className="cursor-pointer text-[var(--color-accent)] hover:underline">
                Cancel
              </button>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Connected Accounts Section                                                */
/* -------------------------------------------------------------------------- */

/** Reauth-action dialog kinds. Each opens the same password-only
 *  modal but with action-specific copy + a runner that calls a
 *  different endpoint (link wallet / unlink wallet / unlink Google). */
type ReauthActionKind = 'link-wallet' | 'unlink-google' | 'unlink-wallet';

const REAUTH_ACTION_COPY: Record<
  ReauthActionKind,
  { title: string; description: string; confirmLabel: string; destructive: boolean }
> = {
  'link-wallet': {
    title: 'Link a wallet',
    description:
      'Linking an Ethereum wallet adds a new way to sign in. Confirm with your current password to proceed.',
    confirmLabel: 'Confirm and link',
    destructive: false,
  },
  'unlink-google': {
    title: 'Unlink Google',
    description:
      'This removes Google from your sign-in methods. Confirm with your current password.',
    confirmLabel: 'Unlink Google',
    destructive: true,
  },
  'unlink-wallet': {
    title: 'Unlink wallet',
    description:
      'This removes your wallet from your sign-in methods. Confirm with your current password.',
    confirmLabel: 'Unlink wallet',
    destructive: true,
  },
};

function ConnectedAccountsSection({ me, onUpdate }: {
  readonly me: MeResponse;
  readonly onUpdate: () => void;
}) {
  // Loading is owned by the dialog for the 3 reauth-gated actions.
  // `googleLinkLoading` stays, that flow doesn't go through the
  // dialog (the password gate is on /confirm-link after the Google
  // round-trip, not on the initiate click here).
  const [googleLinkLoading, setGoogleLinkLoading] = React.useState(false);
  const [showAddEmail, setShowAddEmail] = React.useState(false);
  const [addEmailValue, setAddEmailValue] = React.useState('');
  const [addEmailError, setAddEmailError] = React.useState<string | null>(null);
  const [addEmailLoading, setAddEmailLoading] = React.useState(false);

  // Single dialog for all 3 reauth-gated actions; `null` = closed.
  const [activeAction, setActiveAction] = React.useState<ReauthActionKind | null>(null);

  const googleAccount = me.linkedAccounts.find((a) => a.provider === 'google');
  const walletAccount = me.linkedAccounts.find((a) => a.provider === 'evm_wallet');
  const hasGoogle = googleAccount !== undefined;
  const hasWallet = walletAccount !== undefined;

  /**
   * OAuth-only customers (Gmail-registered, no password set) cannot
   * link/unlink anything because the backend reauthGate requires a
   * password. Surface this dead-end up front: show a toast pointing
   * to the SetPasswordSection and scroll it into view, instead of
   * popping a dialog the user can't satisfy.
   */
  const requireSetPasswordFirst = React.useCallback(() => {
    toast.error('Set a password first to manage sign-in methods.');
    if (typeof document !== 'undefined') {
      document
        .getElementById('set-password-section')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const openAction = React.useCallback(
    (kind: ReauthActionKind) => {
      if (!me.hasPassword) {
        requireSetPasswordFirst();
        return;
      }
      setActiveAction(kind);
    },
    [me.hasPassword, requireSetPasswordFirst],
  );

  // Handle Google link result from redirect query params
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const googleParam = params.get('google');
    if (googleParam === 'linked') {
      toast.success('Google account linked successfully.');
      onUpdate();
      // Clean up URL
      const url = new URL(window.location.href);
      url.searchParams.delete('google');
      window.history.replaceState({}, '', url.pathname);
    } else if (googleParam === 'google_already_linked') {
      toast.error('This Google account is already linked to another user.');
      const url = new URL(window.location.href);
      url.searchParams.delete('google');
      window.history.replaceState({}, '', url.pathname);
    } else if (googleParam === 'google_link_failed') {
      toast.error('Failed to link Google account. Please try again.');
      const url = new URL(window.location.href);
      url.searchParams.delete('google');
      window.history.replaceState({}, '', url.pathname);
    } else if (googleParam === 'not_authenticated') {
      toast.error('Session expired. Please sign in and try again.');
      const url = new URL(window.location.href);
      url.searchParams.delete('google');
      window.history.replaceState({}, '', url.pathname);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddEmail = React.useCallback(async () => {
    const trimmed = addEmailValue.trim().toLowerCase();
    if (trimmed.length === 0) {
      setAddEmailError('Email is required.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setAddEmailError('Please enter a valid email address.');
      return;
    }

    setAddEmailError(null);
    setAddEmailLoading(true);
    try {
      // Wallet re-signature is required for add-email, the backend
      // is only reachable by wallet-only customers and it blocks a
      // stolen-cookie takeover chain. Reuses the same SIWE challenge +
      // sign flow as login and wallet-link.
      let walletProof: { challenge: string; message: string; signature: string };
      try {
        const eth = (
          window as unknown as {
            ethereum?: {
              request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
            };
          }
        ).ethereum;
        if (eth === undefined) {
          setAddEmailError('An EVM wallet is required to add an email to this account.');
          return;
        }

        const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
        const address = accounts[0];
        if (address === undefined) {
          setAddEmailError('Wallet connection was rejected.');
          return;
        }

        const challengeRes = await fetch('/api/customer/auth/wallet/challenge', {
          method: 'POST',
          credentials: 'include',
        });
        if (!challengeRes.ok) {
          setAddEmailError('Failed to request a wallet challenge. Please try again.');
          return;
        }
        const { challenge, nonce } = (await challengeRes.json()) as {
          challenge: string;
          nonce: string;
        };

        const { createSiweMessage } = await import('viem/siwe');
        const message = createSiweMessage({
          address: address as `0x${string}`,
          chainId: 11155111,
          domain: window.location.host,
          nonce,
          uri: window.location.origin,
          version: '1',
          statement: 'Prove wallet ownership to add an email to your Crivacy account.',
        });

        const signature = (await eth.request({
          method: 'personal_sign',
          params: [message, address],
        })) as string;
        if (!signature) {
          setAddEmailError('Wallet signature was rejected.');
          return;
        }

        walletProof = { challenge, message, signature };
      } catch {
        setAddEmailError('Wallet signing failed. Please try again.');
        return;
      }

      const res = await fetch('/api/customer/profile/add-email', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed, walletProof }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        setAddEmailError(body?.error?.message ?? 'Failed to add email.');
        return;
      }

      toast.success('Email added. Please check your inbox to verify.');
      setShowAddEmail(false);
      setAddEmailValue('');
      onUpdate();
    } catch {
      setAddEmailError('An unexpected error occurred.');
    } finally {
      setAddEmailLoading(false);
    }
  }, [addEmailValue, onUpdate]);

  const handleLinkGoogle = React.useCallback(async () => {
    setGoogleLinkLoading(true);
    try {
      const res = await fetch('/api/customer/auth/google/initiate?mode=link', {
        method: 'POST',
        credentials: 'include',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        toast.error(body?.error?.message ?? 'Google login is not available.');
        return;
      }

      const { url } = (await res.json()) as { url: string };
      // Redirect to Google consent screen, callback will redirect back to /settings/security
      window.location.href = url;
    } catch {
      toast.error('Failed to start Google link flow.');
    } finally {
      setGoogleLinkLoading(false);
    }
  }, []);

  /**
   * Action runner for "Link wallet". Receives the verified password
   * from the reauth dialog and runs the full extension flow + link
   * POST. Throws on every failure so the dialog can render the error
   * inline; on success the dialog closes itself and we surface a
   * toast + SWR refresh.
   */
  const runLinkWallet = React.useCallback(
    async (currentPassword: string): Promise<void> => {
      const eth = (
        window as unknown as {
          ethereum?: {
            request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
          };
        }
      ).ethereum;
      if (eth === undefined) {
        throw new Error('No EVM wallet detected. Install MetaMask or a compatible wallet.');
      }

      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      const address = accounts[0];
      if (address === undefined) {
        throw new Error('Wallet connection was rejected.');
      }

      const challengeRes = await fetch('/api/customer/auth/wallet/challenge', {
        method: 'POST',
        credentials: 'include',
      });
      if (!challengeRes.ok) {
        throw new Error('Failed to get wallet challenge.');
      }
      const { challenge, nonce } = (await challengeRes.json()) as {
        challenge: string;
        nonce: string;
      };

      const { createSiweMessage } = await import('viem/siwe');
      const message = createSiweMessage({
        address: address as `0x${string}`,
        chainId: 11155111,
        domain: window.location.host,
        nonce,
        uri: window.location.origin,
        version: '1',
        statement: 'Link this Ethereum wallet to your Crivacy account.',
      });

      const signature = (await eth.request({
        method: 'personal_sign',
        params: [message, address],
      })) as string;
      if (!signature) {
        throw new Error('Message signing was rejected.');
      }

      const res = await fetch('/api/customer/auth/wallet/link', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge,
          message,
          signature,
          provider: 'evm_wallet',
          currentPassword,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? 'Failed to link wallet.');
      }

      toast.success('Wallet linked successfully.');
      onUpdate();
    },
    [onUpdate],
  );

  /**
   * Action runner for "Unlink Google". Reauth gate (Cat 14,
   * F-A2-F1-001): removing a sign-in method is a credential
   * mutation; without a password challenge a stolen session could
   * strip the legit owner's recovery options.
   */
  const runUnlinkGoogle = React.useCallback(
    async (currentPassword: string): Promise<void> => {
      const res = await fetch('/api/customer/auth/google/unlink', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? 'Failed to unlink Google.');
      }

      toast.success('Google account unlinked.');
      onUpdate();
    },
    [onUpdate],
  );

  /**
   * Action runner for "Unlink wallet". Reauth gate (Cat 14,
   * F-A3-F1-001-PRE): same shape as Google unlink so a stolen
   * session can't strip a sign-in method without proving knowledge
   * of the password.
   */
  const runUnlinkWallet = React.useCallback(
    async (currentPassword: string): Promise<void> => {
      const res = await fetch('/api/customer/auth/wallet/unlink', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? 'Failed to unlink wallet.');
      }

      toast.success('Wallet unlinked.');
      onUpdate();
    },
    [onUpdate],
  );

  /**
   * Dispatcher passed to the dialog. Routes the verified password to
   * the runner the user selected when they opened the dialog. Throws
   * if no action is set (defensive, should never happen because the
   * dialog only renders when `activeAction !== null`).
   */
  const handleConfirmAction = React.useCallback(
    async (currentPassword: string): Promise<void> => {
      switch (activeAction) {
        case 'link-wallet':
          return runLinkWallet(currentPassword);
        case 'unlink-google':
          return runUnlinkGoogle(currentPassword);
        case 'unlink-wallet':
          return runUnlinkWallet(currentPassword);
        case null:
          throw new Error('No action selected.');
      }
    },
    [activeAction, runLinkWallet, runUnlinkGoogle, runUnlinkWallet],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-5 w-5" aria-hidden="true" />
          Connected accounts
        </CardTitle>
        <CardDescription>
          Manage how you sign in to your account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Email + Password */}
        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Mail className="h-5 w-5 text-[var(--color-muted)]" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-[var(--color-fg)]">Email &amp; Password</p>
                <p className="text-xs text-[var(--color-muted)]">
                  {me.hasEmail ? (me.email ?? 'Email set') : 'Not set'}
                  {me.hasEmail && me.hasPassword ? ' · password set' : ''}
                  {me.hasEmail && !me.hasPassword ? ' · no password' : ''}
                </p>
              </div>
            </div>
            {me.hasEmail ? (
              <Badge variant="outline" className="border-[var(--color-success)] text-[var(--color-success)]">
                Connected
              </Badge>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddEmail(!showAddEmail)}
              >
                <Mail className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Add email
              </Button>
            )}
          </div>

          {/* Inline add-email form */}
          {showAddEmail && !me.hasEmail && (
            <div className="ml-8 space-y-2">
              <div className="flex gap-2">
                <input
                  type="email"
                  value={addEmailValue}
                  onChange={(e) => { setAddEmailValue(e.target.value); setAddEmailError(null); }}
                  placeholder="you@example.com"
                  disabled={addEmailLoading}
                  maxLength={EMAIL_MAX_LENGTH}
                  className="h-9 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-50"
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleAddEmail(); }}
                />
                <LoadingButton
                  size="sm"
                  loading={addEmailLoading}
                  onClick={handleAddEmail}
                >
                  Save
                </LoadingButton>
              </div>
              {addEmailError !== null && (
                <p className="text-xs text-[var(--color-danger)]" role="alert">
                  {addEmailError}
                </p>
              )}
            </div>
          )}
        </div>

        <Separator />

        {/* Google */}
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-3">
            <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            <div>
              <p className="text-sm font-medium text-[var(--color-fg)]">Google</p>
              <p className="text-xs text-[var(--color-muted)]">
                {hasGoogle
                  ? (googleAccount.email ?? 'Connected')
                  : 'Not connected'}
              </p>
            </div>
          </div>
          {hasGoogle ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => openAction('unlink-google')}
              className="text-[var(--color-danger)]"
            >
              <Unlink2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Unlink
            </Button>
          ) : (
            <LoadingButton
              variant="outline"
              size="sm"
              loading={googleLinkLoading}
              onClick={handleLinkGoogle}
            >
              <Link2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Connect
            </LoadingButton>
          )}
        </div>

        <Separator />

        {/* Ethereum Wallet */}
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-3">
            <Wallet className="h-5 w-5 text-[var(--color-muted)]" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-[var(--color-fg)]">Ethereum Wallet</p>
              {hasWallet ? (
                <CopyableAddress address={walletAccount.displayName ?? ''} />
              ) : (
                <p className="text-xs text-[var(--color-muted)]">Not connected</p>
              )}
            </div>
          </div>
          {hasWallet ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => openAction('unlink-wallet')}
              className="text-[var(--color-danger)]"
            >
              <Unlink2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Unlink
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => openAction('link-wallet')}
            >
              <Link2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Connect
            </Button>
          )}
        </div>
      </CardContent>

      {activeAction !== null && (
        <CustomerReauthActionDialog
          open
          onOpenChange={(open) => {
            if (!open) setActiveAction(null);
          }}
          title={REAUTH_ACTION_COPY[activeAction].title}
          description={REAUTH_ACTION_COPY[activeAction].description}
          confirmLabel={REAUTH_ACTION_COPY[activeAction].confirmLabel}
          destructive={REAUTH_ACTION_COPY[activeAction].destructive}
          onConfirm={handleConfirmAction}
        />
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Active Sessions Section                                                   */
/* -------------------------------------------------------------------------- */

function ActiveSessionsSection({ hasPassword }: { readonly hasPassword: boolean }) {
  const { sessions, isLoading, mutate } = useSessions();
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [revokingAll, setRevokingAll] = React.useState(false);

  const reauth = useReauth();

  const handleRevokeSession = React.useCallback(
    async (sessionId: string) => {
      setRevokingId(sessionId);
      try {
        const res = await fetch(`/api/customer/sessions/${sessionId}`, {
          method: 'DELETE',
          credentials: 'include',
        });

        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
          toast.error(body?.error?.message ?? 'Failed to revoke session.');
          return;
        }

        void mutate();
        toast.success('Session signed out.');
      } catch {
        toast.error('An unexpected error occurred.');
      } finally {
        setRevokingId(null);
      }
    },
    [mutate],
  );

  const handleRevokeAll = React.useCallback(() => {
    const doRevokeAll = async () => {
      setRevokingAll(true);
      try {
        const res = await fetch('/api/customer/sessions/revoke-all', {
          method: 'POST',
          credentials: 'include',
        });

        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
          toast.error(body?.error?.message ?? 'Failed to sign out other sessions.');
          return;
        }

        void mutate();
        toast.success('All other sessions signed out.');
      } catch {
        toast.error('An unexpected error occurred.');
      } finally {
        setRevokingAll(false);
      }
    };

    if (hasPassword) {
      reauth.requireReauth(doRevokeAll);
    } else {
      // No password, just confirm and proceed
      void doRevokeAll();
    }
  }, [hasPassword, reauth, mutate]);

  const otherSessionCount = sessions.filter((s) => !s.isCurrent).length;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Active sessions</CardTitle>
              <CardDescription className="mt-1">
                Devices currently signed in to your account.
              </CardDescription>
            </div>
            {otherSessionCount > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRevokeAll}
                disabled={revokingAll}
                aria-label="Sign out all other sessions"
              >
                <LogOut className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Sign out all others
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                </div>
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <p className="py-4 text-center text-sm text-[var(--color-muted)]">
              No active sessions found.
            </p>
          ) : (
            <div className="space-y-1">
              {sessions.map((session, index) => {
                const DeviceIcon = isMobileDevice(session.deviceName) ? Smartphone : Laptop;

                return (
                  <React.Fragment key={session.id}>
                    {index > 0 && <Separator />}
                    <div className="flex items-center gap-4 py-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface)]">
                        <DeviceIcon className="h-5 w-5 text-[var(--color-muted)]" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-[var(--color-fg)]">
                            {session.deviceName ?? 'Unknown device'}
                          </p>
                          {session.isCurrent && (
                            <Badge
                              variant="outline"
                              className="border-[var(--color-success)] text-[var(--color-success)]"
                            >
                              This device
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-[var(--color-muted)]">
                          {[
                            session.city,
                            session.ip,
                            relativeTime(session.lastActiveAt),
                          ]
                            .filter(Boolean)
                            .join(' \u00b7 ')}
                        </p>
                      </div>
                      {!session.isCurrent && (
                        <LoadingButton
                          variant="ghost"
                          size="sm"
                          loading={revokingId === session.id}
                          onClick={() => handleRevokeSession(session.id)}
                          aria-label={`Sign out ${session.deviceName ?? 'unknown device'}`}
                        >
                          Sign out
                        </LoadingButton>
                      )}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {hasPassword && (
        <ReauthDialog
          open={reauth.isDialogOpen}
          onOpenChange={reauth.setIsDialogOpen}
          onVerify={reauth.verifyPassword}
          onSuccess={reauth.onSuccess}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function SecuritySettingsPage() {
  const { data: me, mutate } = useSWR<MeResponse>('/api/customer/me');

  const handleUpdate = React.useCallback(() => {
    void mutate();
  }, [mutate]);

  if (!me) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
            <Skeleton className="mt-2 h-4 w-64" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Password section, conditional on hasPassword */}
      {me.hasPassword ? (
        <ChangePasswordSection />
      ) : (
        <SetPasswordSection
          onPasswordSet={handleUpdate}
          requiresWalletProof={!me.hasEmail}
        />
      )}

      {/* Email change, only shown when email exists */}
      <EmailChangeSection currentEmail={me.email} onEmailChanged={handleUpdate} />

      {/* Connected accounts */}
      <ConnectedAccountsSection me={me} onUpdate={handleUpdate} />

      {/* Active sessions */}
      <ActiveSessionsSection hasPassword={me.hasPassword} />
    </div>
  );
}
