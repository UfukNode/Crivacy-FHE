'use client';

import * as React from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton } from '@/components/shared/copy-button';
import { FormField } from '@/components/shared/form-field';
import { LoadingButton } from '@/components/shared/loading-button';
import { PasswordInput } from '@/components/shared/password-input';

import {
  RecoveryCodeReveal,
  type RecoveryCodeDownloadContext,
} from './recovery-code-reveal';
import { TotpEnrollmentInstructions } from './totp-enrollment-instructions';

/* -------------------------------------------------------------------------- */
/*  Props                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Audience-specific endpoint URLs consumed by the panel. The panel
 * does not hard-code any audience, firm, admin, and any future
 * audience (e.g. customer if TOTP gets added) wire their own paths
 * here.
 */
export interface TotpPanelEndpoints {
  /** `GET` that returns `{ enrolled, enrolledAt, recoveryCodesRemaining, firmRequiresTotp? }`. */
  readonly status: string;
  /** `POST` that mints a candidate `{ secret, otpauthUrl }`; no DB side effects. */
  readonly setup: string;
  /** `POST` that verifies the new code + rotates. Returns `{ recoveryCodes }`. */
  readonly replace: string;
  /** `POST` that wipes TOTP state. Returns `{ disabled: true }`. */
  readonly disable: string;
  /** `POST` that regenerates recovery codes without touching TOTP. Returns `{ recoveryCodes }`. */
  readonly regenerate: string;
}

/**
 * Status shape, every audience's `/profile/totp/status` endpoint
 * returns this shape. The `firmRequiresTotp` flag is firm-only; other
 * audiences simply omit it (or return false) and the Disable card
 * stays enabled.
 */
interface TotpStatus {
  readonly enrolled: boolean;
  readonly enrolledAt: string | null;
  readonly recoveryCodesRemaining: number;
  readonly firmRequiresTotp?: boolean;
}

export interface TotpManagementPanelProps {
  readonly endpoints: TotpPanelEndpoints;
  /** Optional, threaded into the recovery-code download header + filename. */
  readonly downloadContext: RecoveryCodeDownloadContext | null;
}

/* -------------------------------------------------------------------------- */
/*  Panel                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Shared TOTP management surface. Renders the three cards every
 * audience wants (Replace / Regenerate recovery codes / Disable) on
 * top of a common status fetch. Extracted from the firm + admin
 * settings pages where the same ~500 lines of JSX had drifted
 * into slightly different copies.
 *
 * The component assumes:
 *   - The caller is already authenticated via their audience's
 *     session cookie (handled by the parent route/layout).
 *   - The backend enforces reauth (password + current factor) and
 *     every mutating endpoint is rate-limited; this component passes
 *     fields through unchanged and surfaces the server's error
 *     message verbatim.
 *
 * Audiences:
 *   - firm:  `endpoints` point at `/api/internal/profile/...`
 *            `downloadContext: { email, firmName }`
 *   - admin: `endpoints` point at `/api/internal/admin/profile/...`
 *            `downloadContext: { email, audienceLabel: 'admin' }`
 *
 *   Both surfaces render identical behaviour; a firm's additional
 *   `firmRequiresTotp` policy gate is picked up automatically from
 *   the status response.
 */
export function TotpManagementPanel({
  endpoints,
  downloadContext,
}: TotpManagementPanelProps) {
  const { data, error, isLoading, mutate } = useSWR<TotpStatus>(endpoints.status);

  return (
    <div className="space-y-6">
      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {error !== undefined && error !== null && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-red-400">
              Could not load security settings. Try refreshing the page.
            </p>
          </CardContent>
        </Card>
      )}

      {data !== undefined && (
        <>
          <ReplaceTotpCard
            endpoints={endpoints}
            enrolled={data.enrolled}
            downloadContext={downloadContext}
            onChanged={() => void mutate()}
          />
          <Separator />
          <RegenerateRecoveryCodesCard
            endpoint={endpoints.regenerate}
            enrolled={data.enrolled}
            remaining={data.recoveryCodesRemaining}
            downloadContext={downloadContext}
            onChanged={() => void mutate()}
          />
          <Separator />
          <DisableTotpCard
            endpoint={endpoints.disable}
            enrolled={data.enrolled}
            firmRequiresTotp={data.firmRequiresTotp ?? false}
            onChanged={() => void mutate()}
          />
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Replace 2FA                                                                */
/* -------------------------------------------------------------------------- */

type ReplaceStep = 'idle' | 'reauth' | 'scan' | 'done';

function ReplaceTotpCard({
  endpoints,
  enrolled,
  downloadContext,
  onChanged,
}: {
  readonly endpoints: TotpPanelEndpoints;
  readonly enrolled: boolean;
  readonly downloadContext: RecoveryCodeDownloadContext | null;
  readonly onChanged: () => void;
}) {
  const [step, setStep] = React.useState<ReplaceStep>('idle');
  const [password, setPassword] = React.useState('');
  const [newSecret, setNewSecret] = React.useState('');
  const [otpauthUrl, setOtpauthUrl] = React.useState('');
  const [qrSrc, setQrSrc] = React.useState<string | null>(null);
  const [newCode, setNewCode] = React.useState('');
  const [currentCode, setCurrentCode] = React.useState('');
  const [useRecoveryCode, setUseRecoveryCode] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [generated, setGenerated] = React.useState<readonly string[] | null>(null);

  // QR render, dynamic-import keeps `qrcode` out of the initial
  // bundle. Re-fires each time setup hands back a fresh otpauth URL.
  React.useEffect(() => {
    if (otpauthUrl.length === 0) {
      setQrSrc(null);
      return;
    }
    let cancelled = false;
    async function render(): Promise<void> {
      try {
        const mod = await import('qrcode');
        const dataUrl = await mod.toDataURL(otpauthUrl, {
          width: 192,
          margin: 1,
          color: { dark: '#ffffff', light: '#00000000' },
        });
        if (!cancelled) setQrSrc(dataUrl);
      } catch {
        // Fallback: user can still use the secret manually.
      }
    }
    void render();
    return () => {
      cancelled = true;
    };
  }, [otpauthUrl]);

  const startFlow = React.useCallback(async () => {
    setStep('reauth');
    setError(null);
    setPassword('');
    setNewCode('');
    setCurrentCode('');
    setUseRecoveryCode(false);
    setGenerated(null);
    try {
      const res = await fetch(endpoints.setup, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        setError('Could not start the setup flow. Please try again.');
        setStep('idle');
        return;
      }
      const body = (await res.json()) as { secret: string; otpauthUrl: string };
      setNewSecret(body.secret);
      setOtpauthUrl(body.otpauthUrl);
      setStep('scan');
    } catch {
      setError('Network error. Please try again.');
      setStep('idle');
    }
  }, [endpoints.setup]);

  const submit = React.useCallback(async () => {
    if (password.length === 0) {
      setError('Current password is required.');
      return;
    }
    if (newCode.length < 6) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    if (enrolled && currentCode.trim().length === 0) {
      setError(
        useRecoveryCode
          ? 'Current recovery code is required.'
          : 'Current authenticator code is required.',
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const factorBody: { currentTotpCode?: string; currentRecoveryCode?: string } = enrolled
        ? useRecoveryCode
          ? { currentRecoveryCode: currentCode.trim() }
          : { currentTotpCode: currentCode.trim() }
        : {};
      const res = await fetch(endpoints.replace, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newSecret,
          newTotpCode: newCode,
          currentPassword: password,
          ...factorBody,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? 'Failed to replace TOTP.');
        return;
      }
      const body = (await res.json()) as { recoveryCodes: readonly string[] };
      setGenerated(body.recoveryCodes);
      setPassword('');
      setNewCode('');
      setCurrentCode('');
      setStep('done');
      onChanged();
    } catch {
      setError('An unexpected error occurred.');
    } finally {
      setSubmitting(false);
    }
  }, [password, newSecret, newCode, currentCode, useRecoveryCode, enrolled, onChanged, endpoints.replace]);

  const cancel = React.useCallback(() => {
    setStep('idle');
    setPassword('');
    setNewSecret('');
    setOtpauthUrl('');
    setQrSrc(null);
    setNewCode('');
    setCurrentCode('');
    setUseRecoveryCode(false);
    setError(null);
    setGenerated(null);
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>
          {enrolled
            ? 'Your account is protected by an authenticator app. Replace the secret here if you switched devices or reinstalled the app.'
            : 'Enroll an authenticator app to add a second factor to your sign-in.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {step === 'idle' && (
          <LoadingButton onClick={startFlow} loading={false}>
            {enrolled ? 'Replace authenticator' : 'Enroll authenticator'}
          </LoadingButton>
        )}

        {(step === 'reauth' || step === 'scan') && (
          <div className="space-y-4">
            <TotpEnrollmentInstructions />
            {qrSrc !== null && (
              <div className="flex items-start gap-4 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                <img
                  src={qrSrc}
                  alt="Scan this QR code in your authenticator app"
                  className="h-36 w-36 shrink-0 rounded border border-white/10"
                  width={144}
                  height={144}
                />
                <div className="min-w-0 flex-1 space-y-2 text-xs text-[var(--color-muted)]">
                  <p className="font-medium text-[var(--color-fg)]">
                    Or enter this secret manually:
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="block min-w-0 flex-1 break-all rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[11px] text-[var(--color-fg)]">
                      {newSecret}
                    </code>
                    <CopyButton value={newSecret} iconOnly />
                  </div>
                </div>
              </div>
            )}

            <FormField label="Current password" htmlFor="replace-current-password" required>
              <PasswordInput
                id="replace-current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={submitting}
              />
            </FormField>

            {enrolled && (
              <FormField
                label={useRecoveryCode ? 'Current recovery code' : 'Current authenticator code'}
                htmlFor="replace-current-code"
                description={
                  useRecoveryCode
                    ? 'A one-time recovery code from the list you saved when you first enrolled.'
                    : 'Enter the 6-digit code from your CURRENT authenticator app, this proves the rotation is coming from you.'
                }
                required
              >
                <Input
                  id="replace-current-code"
                  value={currentCode}
                  onChange={(e) => setCurrentCode(e.target.value)}
                  inputMode={useRecoveryCode ? 'text' : 'numeric'}
                  pattern={useRecoveryCode ? undefined : '[0-9]*'}
                  maxLength={useRecoveryCode ? 32 : 8}
                  autoComplete="one-time-code"
                  autoCapitalize={useRecoveryCode ? 'characters' : undefined}
                  placeholder={useRecoveryCode ? 'XXXXX-XXXXX' : '000000'}
                  className="text-center text-lg tracking-widest font-mono"
                  disabled={submitting}
                />
                <div className="mt-1 text-right">
                  <button
                    type="button"
                    onClick={() => {
                      setUseRecoveryCode((prev) => !prev);
                      setCurrentCode('');
                      setError(null);
                    }}
                    disabled={submitting}
                    className="text-xs text-[var(--color-accent)] hover:underline disabled:opacity-50"
                  >
                    {useRecoveryCode
                      ? 'Use authenticator code instead'
                      : 'Lost access? Use a recovery code'}
                  </button>
                </div>
              </FormField>
            )}

            <FormField
              label="Code from new authenticator"
              htmlFor="replace-new-code"
              description="Enter the 6-digit code from your newly-configured app."
              required
            >
              <Input
                id="replace-new-code"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                autoComplete="one-time-code"
                placeholder="000000"
                className="text-center text-lg tracking-widest"
                disabled={submitting}
              />
            </FormField>
            {error !== null && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex gap-2">
              <LoadingButton
                onClick={submit}
                loading={submitting}
                loadingText={enrolled ? 'Replacing...' : 'Enabling...'}
              >
                {enrolled ? 'Replace 2FA' : 'Enable 2FA'}
              </LoadingButton>
              <button
                type="button"
                onClick={cancel}
                disabled={submitting}
                className="rounded border border-white/20 px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {step === 'done' && generated !== null && (
          <RecoveryCodeReveal
            codes={generated}
            context={downloadContext}
            onDismiss={cancel}
          />
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Regenerate recovery codes                                                  */
/* -------------------------------------------------------------------------- */

function RegenerateRecoveryCodesCard({
  endpoint,
  enrolled,
  remaining,
  downloadContext,
  onChanged,
}: {
  readonly endpoint: string;
  readonly enrolled: boolean;
  readonly remaining: number;
  readonly downloadContext: RecoveryCodeDownloadContext | null;
  readonly onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [generated, setGenerated] = React.useState<readonly string[] | null>(null);

  const submit = React.useCallback(async () => {
    if (password.length === 0) {
      setError('Current password is required.');
      return;
    }
    if (code.length < 6) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: password,
          totpCode: code,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? 'Failed to regenerate recovery codes.');
        return;
      }
      const body = (await res.json()) as { recoveryCodes: readonly string[] };
      setGenerated(body.recoveryCodes);
      setPassword('');
      setCode('');
      onChanged();
    } catch {
      setError('An unexpected error occurred.');
    } finally {
      setSubmitting(false);
    }
  }, [password, code, onChanged, endpoint]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recovery codes</CardTitle>
        <CardDescription>
          {enrolled
            ? `${remaining} code${remaining === 1 ? '' : 's'} remaining. Regenerate to invalidate the old batch and issue a fresh set.`
            : 'Enroll 2FA before generating recovery codes.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {generated !== null ? (
          <RecoveryCodeReveal
            codes={generated}
            context={downloadContext}
            onDismiss={() => {
              setGenerated(null);
              setOpen(false);
            }}
          />
        ) : !open ? (
          <LoadingButton
            onClick={() => setOpen(true)}
            loading={false}
            disabled={!enrolled}
            className="disabled:opacity-50"
          >
            Regenerate recovery codes
          </LoadingButton>
        ) : (
          <div className="space-y-4">
            <FormField label="Current password" htmlFor="regen-password" required>
              <PasswordInput
                id="regen-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={submitting}
              />
            </FormField>
            <FormField
              label="Authenticator code"
              htmlFor="regen-code"
              description="Enter the 6-digit code from your authenticator app."
              required
            >
              <Input
                id="regen-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                autoComplete="one-time-code"
                placeholder="000000"
                className="text-center text-lg tracking-widest"
                disabled={submitting}
              />
            </FormField>
            {error !== null && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex gap-2">
              <LoadingButton onClick={submit} loading={submitting} loadingText="Regenerating...">
                Regenerate
              </LoadingButton>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setPassword('');
                  setCode('');
                  setError(null);
                }}
                disabled={submitting}
                className="rounded border border-white/20 px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Disable 2FA                                                                */
/* -------------------------------------------------------------------------- */

function DisableTotpCard({
  endpoint,
  enrolled,
  firmRequiresTotp,
  onChanged,
}: {
  readonly endpoint: string;
  readonly enrolled: boolean;
  readonly firmRequiresTotp: boolean;
  readonly onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [code, setCode] = React.useState('');
  const [useRecoveryCode, setUseRecoveryCode] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const disabled = firmRequiresTotp || !enrolled;

  const submit = React.useCallback(async () => {
    if (password.length === 0) {
      setError('Current password is required.');
      return;
    }
    if (code.length === 0) {
      setError(useRecoveryCode ? 'Recovery code is required.' : 'TOTP code is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: password,
          ...(useRecoveryCode ? { recoveryCode: code } : { totpCode: code }),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? 'Failed to disable 2FA.');
        return;
      }
      toast.success('Two-factor authentication disabled.');
      setOpen(false);
      setPassword('');
      setCode('');
      onChanged();
    } catch {
      setError('An unexpected error occurred.');
    } finally {
      setSubmitting(false);
    }
  }, [password, code, useRecoveryCode, onChanged, endpoint]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Disable two-factor authentication</CardTitle>
        <CardDescription>
          {firmRequiresTotp
            ? 'Your firm policy requires 2FA. Ask an administrator to change the firm setting before disabling.'
            : 'Remove TOTP from your account. You can re-enroll later from this page.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!open && (
          <LoadingButton
            onClick={() => setOpen(true)}
            loading={false}
            className="bg-red-600/20 text-red-300 hover:bg-red-600/30 disabled:opacity-50"
            disabled={disabled}
          >
            Disable 2FA
          </LoadingButton>
        )}
        {open && (
          <div className="space-y-4">
            <FormField label="Current password" htmlFor="disable-password" required>
              <PasswordInput
                id="disable-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={submitting}
              />
            </FormField>
            <FormField
              label={useRecoveryCode ? 'Recovery code' : 'Authenticator code'}
              htmlFor="disable-code"
              required
            >
              <Input
                id="disable-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode={useRecoveryCode ? 'text' : 'numeric'}
                pattern={useRecoveryCode ? undefined : '[0-9]*'}
                maxLength={useRecoveryCode ? 32 : 8}
                autoComplete="one-time-code"
                autoCapitalize={useRecoveryCode ? 'characters' : undefined}
                placeholder={useRecoveryCode ? 'XXXXX-XXXXX' : '000000'}
                className="text-center text-lg tracking-widest font-mono"
                disabled={submitting}
              />
            </FormField>
            <div className="text-right">
              <button
                type="button"
                onClick={() => setUseRecoveryCode((prev) => !prev)}
                disabled={submitting}
                className="text-sm text-[var(--color-accent)] hover:underline disabled:opacity-50"
              >
                {useRecoveryCode
                  ? 'Use authenticator code instead'
                  : 'Lost access? Use a recovery code'}
              </button>
            </div>
            {error !== null && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex gap-2">
              <LoadingButton
                onClick={submit}
                loading={submitting}
                loadingText="Disabling..."
                className="bg-red-600/20 text-red-300 hover:bg-red-600/30"
              >
                Confirm disable
              </LoadingButton>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setPassword('');
                  setCode('');
                  setError(null);
                }}
                disabled={submitting}
                className="rounded border border-white/20 px-3 py-1.5 text-sm hover:bg-white/5 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
