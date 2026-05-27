'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { AuthShell } from '@/components/shared/auth-shell';
import { FormField } from '@/components/shared/form-field';
import { LoadingButton } from '@/components/shared/loading-button';
import { PasswordInput } from '@/components/shared/password-input';
import { TurnstileWidget } from '@/components/shared/turnstile-widget';
import { EMAIL_MAX_LENGTH, emailSchema, existingPasswordSchema, totpCodeSchema } from '@/lib/validation/auth';

/**
 * Dashboard login, firm user email + password + optional TOTP.
 *
 * Mirrors the customer login stack (react-hook-form + zod + shared UI
 * primitives) so the two flows stay visually and behaviourally
 * identical. Server-side error codes drive the branching:
 *
 *   - `totp_required`         → reveal the TOTP field inline
 *   - `totp_invalid`          → surface under the TOTP field
 *   - `account_locked`        → show the retry window copy as-is
 *   - everything else         → generic invalid-credentials toast
 *
 * The form never performs a browser POST, `handleSubmit` preventDefaults
 * and drives `fetch`. That means a browser reload cannot resubmit
 * credentials ("resend form"), and the transient error state is
 * cleared on mount because it lives only in component state.
 */

const LoginSchema = z.object({
  email: emailSchema,
  password: existingPasswordSchema,
  // Empty string is allowed in the form field while TOTP is hidden;
  // the submit handler converts it to `undefined` before sending.
  totpCode: z.union([z.literal(''), totpCodeSchema]),
  // Recovery code, used as a fallback when the user has lost
  // their authenticator app. Same "empty means not supplied"
  // semantics as `totpCode`; the submit handler strips the empty
  // string and the server normalises dashes + whitespace.
  recoveryCode: z.string().max(32).optional().or(z.literal('')),
  // Required, login is a credential-accepting public endpoint. The
  // widget populates this via setValue() in onSuccess; submit is
  // gated by zod min(1) so the user can't fire fetch before the
  // Turnstile challenge completes.
  turnstileToken: z.string().min(1, 'Captcha verification is required.'),
  // Default off → refresh cookie dies on browser close. Opt-in
  // persists for the central AUTH_JWT_REFRESH_TTL_SECONDS window
  // (backend reads the flag from this same field).
  rememberMe: z.boolean(),
});

type LoginFormData = z.infer<typeof LoginSchema>;

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [totpRequired, setTotpRequired] = useState(false);
  // When `true` the second-factor panel swaps to a recovery-code
  // input. Reset whenever `totpRequired` re-fires so a fresh login
  // attempt starts on the default (TOTP) branch.
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const totpInputRef = useRef<HTMLInputElement | null>(null);
  const recoveryInputRef = useRef<HTMLInputElement | null>(null);

  // Session-redirect toasts, the middleware appends ?reason=... when
  // it bounces an unauthenticated user here.
  useEffect(() => {
    const reason = (searchParams?.get('reason') ?? null);
    if (reason === 'session_expired') {
      toast.info('Your session has expired. Please sign in again.');
    } else if (reason === 'session_superseded') {
      toast.info('You were signed out because you logged in on another device.');
    }
  }, [searchParams]);

  const {
    register,
    handleSubmit,
    setFocus,
    setValue,
    watch,
    setError: setFieldError,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(LoginSchema),
    defaultValues: {
      email: '',
      password: '',
      totpCode: '',
      recoveryCode: '',
      turnstileToken: '',
      rememberMe: false,
    },
  });

  const rememberMeValue = watch('rememberMe');

  // Auto-focus the currently visible second-factor field whenever it
  // mounts or the user toggles between TOTP and recovery-code mode.
  useEffect(() => {
    if (!totpRequired) return;
    if (useRecoveryCode) {
      recoveryInputRef.current?.focus();
    } else {
      totpInputRef.current?.focus();
    }
  }, [totpRequired, useRecoveryCode]);

  async function onSubmit(data: LoginFormData) {
    setLoading(true);
    try {
      const res = await fetch('/api/internal/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: data.email,
          password: data.password,
          turnstileToken: data.turnstileToken,
          rememberMe: data.rememberMe,
          // Include whichever second factor the user chose. We only
          // send one at a time, the server prefers `recoveryCode`
          // when both are present but sending just one keeps the
          // audit trail accurate to the user's intent.
          ...(totpRequired && !useRecoveryCode && data.totpCode !== ''
            ? { totpCode: data.totpCode }
            : {}),
          ...(totpRequired &&
          useRecoveryCode &&
          data.recoveryCode !== undefined &&
          data.recoveryCode !== ''
            ? { recoveryCode: data.recoveryCode }
            : {}),
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        const code = body.error?.code ?? 'unknown';
        const message = body.error?.message ?? 'Login failed.';

        if (code === 'totp_required') {
          setTotpRequired(true);
          setLoading(false);
          // Don't toast, the revealed field is the signal.
          return;
        }
        if (code === 'totp_invalid') {
          setFieldError('totpCode', { type: 'server', message });
          setLoading(false);
          return;
        }
        if (code === 'recovery_code_invalid') {
          setFieldError('recoveryCode', { type: 'server', message });
          setLoading(false);
          return;
        }
        if (code === 'account_locked') {
          toast.error(message);
          setLoading(false);
          return;
        }
        // Generic credential failure. Don't leak WHICH field was
        // wrong, mirror the server's anti-enumeration wording.
        toast.error(message);
        setFocus('password');
        setLoading(false);
        return;
      }

      // Cookies are set by the API response (httpOnly). Kick off the
      // soft navigation but DO NOT clear `loading`, `router.push` is
      // async and resolves fractions of a second after this statement
      // returns. Clearing here would re-enable the Sign in button
      // during the navigation window, letting the user accidentally
      // (or maliciously) fire a second login request. Leaving the
      // loading flag on until the page unloads closes the gap.
      const from = (searchParams?.get('from') ?? null);
      const safeFrom =
        from !== null && from.startsWith('/') && !from.startsWith('//') ? from : '/dashboard';
      router.push(safeFrom);
    } catch {
      toast.error('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Sign in</CardTitle>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Manage your Crivacy KYC integration
        </p>
      </CardHeader>

      <CardContent>
        <form id="dashboard-login-form" noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormField label="Email" htmlFor="email" error={errors.email?.message} required>
            <Input
              id="email"
              type="email"
              placeholder="you@company.com"
              autoComplete="email"
              maxLength={EMAIL_MAX_LENGTH}
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'email-error' : undefined}
              disabled={loading}
              {...register('email')}
            />
          </FormField>

          <FormField label="Password" htmlFor="password" error={errors.password?.message} required>
            <PasswordInput
              id="password"
              placeholder="Enter your password"
              autoComplete="current-password"
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? 'password-error' : undefined}
              disabled={loading}
              {...register('password')}
            />
          </FormField>

          {/* Second-factor panel, mounts both TOTP and recovery-code
              inputs regardless of mode so layout stays stable. The
              user toggles between them with the link below; the
              hidden input is not sent (submit-time check skips empty
              strings per the relevant mode). */}
          {(() => {
            const { ref: totpFormRef, ...totpFormRest } = register('totpCode');
            const { ref: recoveryFormRef, ...recoveryFormRest } = register('recoveryCode');
            return (
              <div className={totpRequired ? 'space-y-2' : 'hidden'}>
                <div className={useRecoveryCode ? 'hidden' : 'block'}>
                  <FormField
                    label="Authenticator code"
                    htmlFor="totpCode"
                    error={errors.totpCode?.message}
                    description="Enter the 6-digit code from your authenticator app."
                    required={totpRequired && !useRecoveryCode}
                  >
                    <Input
                      id="totpCode"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="one-time-code"
                      maxLength={8}
                      placeholder="000000"
                      className="text-center text-lg tracking-widest"
                      aria-invalid={!!errors.totpCode}
                      disabled={loading}
                      {...totpFormRest}
                      ref={(el) => {
                        totpFormRef(el);
                        totpInputRef.current = el;
                      }}
                    />
                  </FormField>
                </div>

                <div className={useRecoveryCode ? 'block' : 'hidden'}>
                  <FormField
                    label="Recovery code"
                    htmlFor="recoveryCode"
                    error={errors.recoveryCode?.message}
                    description="Enter one of the backup codes you saved when you enrolled. Each code can only be used once."
                    required={totpRequired && useRecoveryCode}
                  >
                    <Input
                      id="recoveryCode"
                      type="text"
                      inputMode="text"
                      autoComplete="one-time-code"
                      autoCapitalize="characters"
                      spellCheck={false}
                      maxLength={32}
                      placeholder="XXXXX-XXXXX"
                      className="text-center text-lg tracking-widest font-mono"
                      aria-invalid={!!errors.recoveryCode}
                      disabled={loading}
                      {...recoveryFormRest}
                      ref={(el) => {
                        recoveryFormRef(el);
                        recoveryInputRef.current = el;
                      }}
                    />
                  </FormField>
                </div>

                <div className="text-right">
                  <button
                    type="button"
                    onClick={() => setUseRecoveryCode((prev) => !prev)}
                    disabled={loading}
                    className="text-sm text-[var(--color-accent)] hover:underline disabled:opacity-50"
                  >
                    {useRecoveryCode
                      ? 'Use your authenticator app instead'
                      : 'Lost access? Use a recovery code'}
                  </button>
                </div>
              </div>
            );
          })()}

          <div className="flex items-center justify-between">
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={rememberMeValue}
                onCheckedChange={(checked) => setValue('rememberMe', checked === true)}
                aria-label="Remember me"
              />
              <span className="text-sm text-[var(--color-fg)]">Remember me</span>
            </label>
            <Link
              href="/dashboard/forgot-password"
              className="text-sm text-[var(--color-accent)] hover:underline"
            >
              Forgot password?
            </Link>
          </div>

          <TurnstileWidget
            onSuccess={(token) => setValue('turnstileToken', token, { shouldValidate: true })}
            onExpire={() => setValue('turnstileToken', '', { shouldValidate: true })}
            onError={() => setValue('turnstileToken', '', { shouldValidate: true })}
          />

          <LoadingButton
            type="submit"
            loading={loading}
            loadingText="Signing in..."
            className="w-full"
          >
            Sign in
          </LoadingButton>
        </form>
      </CardContent>

      <CardFooter className="justify-center">
        <p className="text-sm text-[var(--color-muted)]">
          Firm dashboard &middot; not a partner?{' '}
          <Link href="/login" className="text-[var(--color-accent)] hover:underline">
            End-user sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}

export default function DashboardLoginPage() {
  return (
    <AuthShell>
      <Suspense
        fallback={
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-xl">Sign in</CardTitle>
            </CardHeader>
          </Card>
        }
      >
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
