'use client';

import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import { AuthShell } from '@/components/shared/auth-shell';
import { FormField } from '@/components/shared/form-field';
import { LoadingButton } from '@/components/shared/loading-button';
import { PasswordInput } from '@/components/shared/password-input';
import { TurnstileWidget } from '@/components/shared/turnstile-widget';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  EMAIL_MAX_LENGTH,
  emailSchema,
  existingPasswordSchema,
  totpCodeSchema,
} from '@/lib/validation/auth';

/**
 * Admin login, single-step (firm-dashboard parity).
 *
 * Mirrors the firm dashboard `/dashboard/login` page byte-for-byte at
 * the state-machine level: one form, one POST, TOTP field hidden by
 * default. The pre-MP-A two-step variant (challenge token + 2-min
 * countdown + step-2 OTP screen) is gone, the 2-minute TTL was
 * shorter than a typical "open authenticator app + transcribe code"
 * roundtrip and produced "challenge expired" toasts before the user
 * could submit.
 *
 * Server-side error codes drive the branching:
 *   - `totp_required`   → reveal the TOTP field inline
 *   - `invalid_totp_code` → surface under the TOTP field
 *   - `account_locked`  → show the retry-window copy as-is
 *   - everything else   → generic invalid-credentials toast
 */

const LoginSchema = z.object({
  email: emailSchema,
  password: existingPasswordSchema,
  // Empty string is allowed in the form field while TOTP is hidden;
  // the submit handler converts it to `undefined` before sending.
  totpCode: z.union([z.literal(''), totpCodeSchema]),
  // Required, login is a credential-accepting public endpoint. The
  // widget populates this via setValue() on success; submit is gated
  // by min(1) so the user can't fire fetch before Turnstile completes.
  turnstileToken: z.string().min(1, 'Captcha verification is required.'),
});

type LoginFormData = z.infer<typeof LoginSchema>;

export default function AdminLoginPage() {
  const [loading, setLoading] = useState(false);
  const [totpRequired, setTotpRequired] = useState(false);
  const totpInputRef = useRef<HTMLInputElement | null>(null);
  const turnstileResetRef = useRef(0);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(LoginSchema),
    defaultValues: {
      email: '',
      password: '',
      totpCode: '',
      turnstileToken: '',
    },
  });

  // Auto-focus the TOTP input the moment it reveals, matches the
  // firm dashboard UX so the user types straight from their
  // authenticator app without an extra click.
  useEffect(() => {
    if (totpRequired) {
      totpInputRef.current?.focus();
    }
  }, [totpRequired]);

  async function onSubmit(data: LoginFormData) {
    setLoading(true);
    try {
      const res = await fetch('/api/internal/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: data.email,
          password: data.password,
          turnstileToken: data.turnstileToken,
          // Only send `totpCode` when the field has been revealed and
          // populated. Sending an empty string trips the backend's
          // `totpCodeSchema` validator (it requires 6 digits when
          // present), so we strip it here.
          ...(totpRequired && data.totpCode !== '' ? { totpCode: data.totpCode } : {}),
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string };
        };
        const code = body.error?.code ?? 'unknown';
        const message = body.error?.message ?? 'Login failed.';

        if (code === 'totp_required') {
          // Reveal the TOTP field. No toast, the field reveal is
          // the signal. Reset the Turnstile so the next submit gets
          // a fresh token (single-use).
          setTotpRequired(true);
          turnstileResetRef.current += 1;
          setValue('turnstileToken', '', { shouldValidate: true });
          setLoading(false);
          return;
        }
        if (code === 'invalid_totp_code') {
          setError('totpCode', { type: 'server', message });
          turnstileResetRef.current += 1;
          setValue('turnstileToken', '', { shouldValidate: true });
          setLoading(false);
          return;
        }
        if (code === 'account_locked') {
          toast.error(message);
          setLoading(false);
          return;
        }
        // Generic credential failure, same anti-enumeration wording
        // the server uses. Reset Turnstile + focus password.
        toast.error(message);
        turnstileResetRef.current += 1;
        setValue('turnstileToken', '', { shouldValidate: true });
        setFocus('password');
        setLoading(false);
        return;
      }

      // Cookies are httpOnly and set by the API response. Hard
      // navigation to /admin: the layout reads the cookie server-side,
      // so a `router.push` would race the cookie-write and could land
      // on a redirect loop. `window.location.href` forces a fresh
      // request that includes the new cookies.
      window.location.href = '/admin';
    } catch {
      toast.error('Network error. Please try again.');
      setLoading(false);
    }
  }

  // Hidden-field ref hookup, react-hook-form's `register` returns its
  // own ref; we shadow it with a local one so the auto-focus effect
  // can reach the input element.
  const { ref: totpFormRef, ...totpFormRest } = register('totpCode');

  return (
    <AuthShell>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Admin sign in</CardTitle>
          <CardDescription>
            {totpRequired
              ? 'Enter the 6-digit code from your authenticator app.'
              : 'Use your admin credentials.'}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <FormField label="Email" htmlFor="email" error={errors.email?.message} required>
              <Input
                id="email"
                type="email"
                placeholder="admin@crivacy.io"
                autoComplete="email"
                maxLength={EMAIL_MAX_LENGTH}
                aria-invalid={!!errors.email}
                disabled={loading}
                {...register('email')}
              />
            </FormField>

            <FormField
              label="Password"
              htmlFor="password"
              error={errors.password?.message}
              required
            >
              <PasswordInput
                id="password"
                placeholder="Enter your password"
                autoComplete="current-password"
                aria-invalid={!!errors.password}
                disabled={loading}
                {...register('password')}
              />
            </FormField>

            {/* TOTP field, hidden until the server returns
                `totp_required`. Layout stays stable because the
                container collapses to `hidden` rather than
                conditionally unmounting. */}
            <div className={totpRequired ? 'block' : 'hidden'}>
              <FormField
                label="Authenticator code"
                htmlFor="totpCode"
                error={errors.totpCode?.message}
                description="Enter the 6-digit code from your authenticator app."
                required={totpRequired}
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

            <TurnstileWidget
              key={turnstileResetRef.current}
              onSuccess={(token) => setValue('turnstileToken', token, { shouldValidate: true })}
              onExpire={() => setValue('turnstileToken', '', { shouldValidate: true })}
              onError={() => setValue('turnstileToken', '', { shouldValidate: true })}
            />

            <LoadingButton
              type="submit"
              loading={loading}
              loadingText={totpRequired ? 'Verifying...' : 'Signing in...'}
              className="w-full"
            >
              {totpRequired ? 'Verify code' : 'Continue'}
            </LoadingButton>
          </form>
        </CardContent>

        <CardFooter className="justify-center">
          <p className="text-xs text-[var(--color-muted)]">Platform operators only.</p>
        </CardFooter>
      </Card>
    </AuthShell>
  );
}
