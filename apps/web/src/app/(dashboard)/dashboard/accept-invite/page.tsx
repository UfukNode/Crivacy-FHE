'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';

import { CopyButton } from '@/components/shared/copy-button';
import { PasswordInput } from '@/components/shared/password-input';
import { PasswordStrength, isPasswordStrong } from '@/components/shared/password-strength';
import { TotpEnrollmentInstructions } from '@/components/shared/security';

/**
 * Pull the invite token from `window.location.hash` (preferred) or
 * the `?token=` query param (fallback for legacy emails still in the
 * 72h window). Fragment delivery keeps the token out of server access
 * logs, CDN traces, and Referer headers, fragments are never put on
 * the wire by the browser.
 *
 * Accepts both raw `#XYZ` and `#token=XYZ` so the URL format can stay
 * human-readable even though the canonical emitter writes the latter.
 */
function readInviteTokenFromLocation(
  hash: string,
  searchParams: URLSearchParams,
): string {
  const trimmedHash = hash.startsWith('#') ? hash.slice(1) : hash;
  if (trimmedHash.length > 0) {
    // Try `token=<value>` first (canonical shape we emit in emails);
    // fall back to the whole fragment so raw `#<token>` URLs pasted
    // by the user still work.
    const hashParams = new URLSearchParams(trimmedHash);
    const fromHashParam = hashParams.get('token');
    if (fromHashParam !== null && fromHashParam.length > 0) {
      return fromHashParam;
    }
    if (!trimmedHash.includes('=')) {
      return decodeURIComponent(trimmedHash);
    }
  }
  return (searchParams?.get('token') ?? null) ?? '';
}

type ValidateResponse = {
  readonly email: string;
  readonly firmName: string;
  readonly totpSecret: string;
  readonly otpauthUrl: string;
};

type ValidateError = {
  readonly status: number;
  readonly code: string;
  readonly message: string;
};

/**
 * Firm-user onboarding: accept-invite page.
 *
 * Public route reached via the magic-link in the welcome email.
 * Flow:
 *
 *   1. Pull `?token=...` from the URL and POST to
 *      `/api/internal/auth/invite/validate`. Surface a typed error on
 *      404 / 410 so the user sees "link expired" vs "unknown" rather
 *      than a generic failure.
 *   2. Render the acceptance form with:
 *        - the recipient's email (read-only)
 *        - a QR code + manual secret for the authenticator app
 *        - password + confirm-password fields
 *        - a 6-digit TOTP code field
 *   3. Submit to `/api/internal/auth/invite/accept`. The server sets
 *      the auth cookies; we just redirect to `/dashboard`.
 *
 * The TOTP secret returned by step 1 is held in React state ONLY and
 * replayed verbatim in step 3 so the server can verify the code
 * against the same secret it offered. Nothing is persisted until the
 * user proves possession.
 */
export default function AcceptInvitePage() {
  const searchParams = useSearchParams();

  // The hash isn't available during SSR, initialise empty and fill
  // it in on mount via useEffect. While empty, the validation effect
  // short-circuits into the "missing token" error state, which then
  // gets replaced once the hash arrives. `(searchParams?.get('token') ?? null)`
  // runs synchronously so legacy `?token=` URLs still validate on
  // the first render.
  const [token, setToken] = useState<string>(() =>
    typeof window === 'undefined'
      ? (searchParams?.get('token') ?? null) ?? ''
      : readInviteTokenFromLocation(window.location.hash, searchParams ?? new URLSearchParams()),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const next = readInviteTokenFromLocation(
      window.location.hash,
      searchParams ?? new URLSearchParams(),
    );
    if (next !== token) setToken(next);
    // The hash never changes during this page's lifecycle, so we only
    // read it once at mount. Re-reading on `hashchange` isn't useful —
    // an invite flow never hash-navigates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [loadingValidation, setLoadingValidation] = useState(true);
  const [validationError, setValidationError] = useState<ValidateError | null>(null);
  const [context, setContext] = useState<ValidateResponse | null>(null);
  const [qrSrc, setQrSrc] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Recovery-code payload, only populated after a successful accept.
  // Holding it in React state (never re-requestable) is what enforces
  // the "shown once" contract with the server. Leaving this page
  // without saving the codes means they're gone forever.
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [recoverySaved, setRecoverySaved] = useState(false);

  // --- Step 1: validate the token ---
  useEffect(() => {
    let cancelled = false;

    if (token.length === 0) {
      setValidationError({
        status: 400,
        code: 'invalid_request',
        message: 'The invitation link is missing a token. Please use the link from your email.',
      });
      setLoadingValidation(false);
      return () => {
        cancelled = true;
      };
    }

    async function run(): Promise<void> {
      try {
        const res = await fetch('/api/internal/auth/invite/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const body = (await res.json()) as Record<string, unknown>;
        if (cancelled) return;

        if (!res.ok) {
          const err = (body['error'] as Record<string, unknown>) ?? {};
          setValidationError({
            status: res.status,
            code: (err['code'] as string) ?? 'invalid_request',
            message:
              (err['message'] as string) ?? 'This invitation link cannot be used.',
          });
          return;
        }

        setContext(body as unknown as ValidateResponse);
      } catch {
        if (!cancelled) {
          setValidationError({
            status: 0,
            code: 'network_error',
            message: 'Network error. Please try again.',
          });
        }
      } finally {
        if (!cancelled) setLoadingValidation(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // --- Render the QR once the otpauth URL arrives ---
  useEffect(() => {
    if (context === null) return;
    let cancelled = false;
    async function draw(): Promise<void> {
      if (context === null) return;
      try {
        const qrcodeModule = await import('qrcode');
        const dataUrl = await qrcodeModule.toDataURL(context.otpauthUrl, {
          width: 192,
          margin: 1,
          color: {
            dark: '#ffffff',
            light: '#00000000',
          },
        });
        if (!cancelled) setQrSrc(dataUrl);
      } catch {
        // QR library failed, fallback to manual secret only, still usable.
      }
    }
    void draw();
    return () => {
      cancelled = true;
    };
  }, [context]);

  // --- Step 3: accept ---
  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (context === null) return;

    if (!isPasswordStrong(password)) {
      setSubmitError(
        'Password must be at least 8 characters and include uppercase, number, and special character.',
      );
      return;
    }

    if (password !== confirmPassword) {
      setSubmitError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch('/api/internal/auth/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          password,
          totpSecret: context.totpSecret,
          totpCode,
        }),
      });

      if (!res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        const err = (body['error'] as Record<string, unknown>) ?? {};
        setSubmitError((err['message'] as string) ?? 'Failed to accept invitation.');
        return;
      }

      // Parse the recovery-code batch the server just emitted. The
      // user now holds an authenticated session (cookies are set),
      // but we keep them on this page until they confirm they've
      // saved the codes, that's the only moment they'll ever see
      // them in plaintext.
      const body = (await res.json()) as { readonly recoveryCodes?: readonly string[] };
      if (Array.isArray(body.recoveryCodes) && body.recoveryCodes.length > 0) {
        setRecoveryCodes(body.recoveryCodes);
      } else {
        // Server didn't return codes (shouldn't happen, but be safe —
        // fall through to the dashboard rather than stranding the user).
        window.location.href = '/dashboard';
      }
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleDownloadCodes(): void {
    if (recoveryCodes === null || context === null) return;
    const header = [
      `Crivacy recovery codes, ${context.firmName}`,
      `Account: ${context.email}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      'Each code works exactly once if you lose access to your authenticator app.',
      'Keep them somewhere safe. Regenerating in Settings voids this list.',
      '',
    ].join('\n');
    const blob = new Blob([`${header}${recoveryCodes.join('\n')}\n`], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crivacy-recovery-codes-${context.firmName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-[var(--color-fg)]">
            {recoveryCodes !== null ? 'Save your recovery codes' : 'Welcome to Crivacy'}
          </h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {recoveryCodes !== null
              ? 'Store these backup codes somewhere safe. You won\u2019t see them again.'
              : context !== null
                ? `Set up your account for ${context.firmName}`
                : 'Verifying your invitation\u2026'}
          </p>
        </div>

        {recoveryCodes !== null && (
          <div className="space-y-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <div
              role="alert"
              className="rounded-[var(--radius-sm)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-xs text-[var(--color-fg)]"
            >
              <p className="font-semibold text-[var(--color-warning)]">
                Each code works only once and only if you lose your authenticator.
              </p>
              <p className="mt-1 text-[var(--color-muted)]">
                Print them, save them to a password manager, or store them in a
                secure location. Regenerating in settings voids this list.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {recoveryCodes.map((code) => (
                <code
                  key={code}
                  className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-center font-mono text-sm text-[var(--color-fg)]"
                >
                  {code}
                </code>
              ))}
            </div>

            <div className="flex gap-2">
              <CopyButton
                value={recoveryCodes.join('\n')}
                label="Copy all"
                variant="outline"
                className="flex-1"
              />
              <button
                type="button"
                onClick={handleDownloadCodes}
                className="flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface)]"
              >
                Download .txt
              </button>
            </div>

            <label className="flex items-start gap-2 text-xs text-[var(--color-fg)]">
              <input
                type="checkbox"
                checked={recoverySaved}
                onChange={(e) => {
                  setRecoverySaved(e.target.checked);
                }}
                className="mt-0.5 h-4 w-4 rounded border-[var(--color-border)]"
              />
              <span>
                I have saved my recovery codes somewhere safe. I understand I
                won&apos;t see them again.
              </span>
            </label>

            <button
              type="button"
              disabled={!recoverySaved}
              onClick={() => {
                window.location.href = '/dashboard';
              }}
              className="w-full rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-[var(--shadow-sm)] transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Continue to dashboard
            </button>
          </div>
        )}

        {recoveryCodes === null && loadingValidation && (
          <div
            role="status"
            className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-6 text-center text-sm text-[var(--color-muted)]"
          >
            Checking invitation…
          </div>
        )}

        {recoveryCodes === null && !loadingValidation && validationError !== null && (
          <div
            role="alert"
            className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-4 text-sm text-[var(--color-danger)]"
          >
            <p className="font-semibold">
              {validationError.status === 410
                ? 'This invitation link is no longer valid.'
                : 'We could not use this invitation.'}
            </p>
            <p className="mt-1 text-[var(--color-fg)]/80">{validationError.message}</p>
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              Ask your Crivacy contact to send a new invitation.
            </p>
          </div>
        )}

        {recoveryCodes === null && context !== null && (
          <form
            noValidate
            onSubmit={handleSubmit}
            className="space-y-5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
          >
            {/* Read-only email */}
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
                Email
              </label>
              <div className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]">
                {context.email}
              </div>
            </div>

            {/* TOTP enrolment */}
            <div className="space-y-2">
              <label className="block text-xs font-medium text-[var(--color-muted)]">
                Two-factor authentication{' '}
                <span className="font-normal text-[var(--color-muted)]">
                  (required for dashboard access)
                </span>
              </label>
              <TotpEnrollmentInstructions />
              <div className="flex items-center gap-4 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                {qrSrc !== null ? (
                  <img
                    src={qrSrc}
                    alt="Scan this QR with your authenticator app"
                    className="h-36 w-36 shrink-0"
                  />
                ) : (
                  <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-[var(--color-border)] text-xs text-[var(--color-muted)]">
                    Loading QR…
                  </div>
                )}
                <div className="min-w-0 flex-1 text-xs text-[var(--color-muted)]">
                  <p className="mb-1 font-medium text-[var(--color-fg)]">
                    Or enter this secret manually:
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="block flex-1 break-all rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[11px] text-[var(--color-fg)]">
                      {context.totpSecret}
                    </code>
                    <CopyButton value={context.totpSecret} iconOnly />
                  </div>
                </div>
              </div>
            </div>

            {/* Password */}
            <div>
              <label
                htmlFor="accept-password"
                className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
              >
                New password
              </label>
              <PasswordInput
                id="accept-password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
              />
              {password.length === 0 ? (
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  Min 8 characters with uppercase, number, and special character.
                </p>
              ) : (
                <div className="mt-2">
                  <PasswordStrength password={password} />
                </div>
              )}
            </div>

            <div>
              <label
                htmlFor="accept-confirm"
                className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
              >
                Confirm password
              </label>
              <PasswordInput
                id="accept-confirm"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                }}
                aria-invalid={
                  confirmPassword.length > 0 && confirmPassword !== password
                }
                aria-describedby={
                  confirmPassword.length > 0 && confirmPassword !== password
                    ? 'accept-confirm-error'
                    : undefined
                }
              />
              {/*
                Inline mismatch hint, matches the `settings/security`
                and `reset-password` pattern so the feedback shape is
                consistent across every password-setting surface in the
                project (no toast for typo-grade errors).
               */}
              {confirmPassword.length > 0 && confirmPassword !== password && (
                <p
                  id="accept-confirm-error"
                  role="alert"
                  className="mt-1 text-xs text-[var(--color-danger)]"
                >
                  Passwords do not match.
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="accept-totp"
                className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
              >
                6-digit authenticator code
              </label>
              <input
                id="accept-totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={totpCode}
                onChange={(e) => {
                  setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                }}
                className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-center font-mono text-lg tracking-widest text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)]"
              />
            </div>

            {submitError !== null && (
              <div
                role="alert"
                className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3 text-sm text-[var(--color-danger)]"
              >
                {submitError}
              </div>
            )}

            <button
              type="submit"
              disabled={
                submitting
                || !isPasswordStrong(password)
                || password !== confirmPassword
                || totpCode.length !== 6
              }
              className="w-full rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent-contrast)] shadow-[var(--shadow-sm)] transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Setting up…' : 'Accept invitation'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
