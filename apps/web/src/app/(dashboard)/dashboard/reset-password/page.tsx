'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, Mail } from 'lucide-react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { AuthShell } from '@/components/shared/auth-shell';
import { FormField } from '@/components/shared/form-field';
import { LoadingButton } from '@/components/shared/loading-button';
import { PasswordInput } from '@/components/shared/password-input';
import { PasswordStrength, isPasswordStrong } from '@/components/shared/password-strength';
import { VerificationCodeInput } from '@/components/shared/verification-code-input';
import { newPasswordSchema } from '@/lib/validation/auth';

/**
 * Firm-dashboard reset-password page.
 *
 * Two-step flow, mirrors the customer variant:
 *   1. Enter the 6-digit code from the email.
 *   2. Choose + confirm a new password.
 *
 * Error codes from the API drive the terminal states (expired,
 * max_attempts). On reset success the page shows a confirmation and
 * a CTA back to /dashboard/login so the user can sign in with the
 * new password, their existing sessions were revoked server-side.
 */

const NewPasswordSchema = z
  .object({
    password: newPasswordSchema,
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type NewPasswordFormData = z.infer<typeof NewPasswordSchema>;

type ResetStep =
  | 'code'
  | 'password'
  | 'submitting'
  | 'success'
  | 'expired'
  | 'max_attempts'
  | 'no_email';

interface ResetResponse {
  readonly status?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
}

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const email = (searchParams?.get('email') ?? null);
  const [step, setStep] = useState<ResetStep>(email ? 'code' : 'no_email');
  const [codeError, setCodeError] = useState<string | undefined>();
  const [verifiedCode, setVerifiedCode] = useState('');
  const [resending, setResending] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<NewPasswordFormData>({
    resolver: zodResolver(NewPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  const passwordValue = watch('password');

  // Hit the pre-verify endpoint so we only advance to the password
  // step on a code that the server actually accepts. Previously the
  // UI advanced on any 6-digit string and the server only rejected
  // at the final submit, confusing for users and bad for the
  // "resend code" flow where the old code still looked valid.
  const handleCodeComplete = useCallback(
    async (code: string) => {
      if (!email) return;
      setVerifyingCode(true);
      try {
        const response = await fetch('/api/internal/auth/verify-reset-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, code }),
        });
        if (response.ok) {
          setVerifiedCode(code);
          setCodeError(undefined);
          setStep('password');
          return;
        }
        const body = (await response.json().catch(() => ({}))) as ResetResponse;
        const errorCode = body.error?.code ?? 'invalid';
        if (errorCode === 'code_expired') {
          setStep('expired');
        } else if (errorCode === 'code_max_attempts') {
          setStep('max_attempts');
        } else {
          setCodeError(body.error?.message ?? 'Invalid code. Please try again.');
          setVerifiedCode('');
        }
      } catch {
        setCodeError('Network error. Please try again.');
      } finally {
        setVerifyingCode(false);
      }
    },
    [email],
  );

  async function onSubmitPassword(data: NewPasswordFormData) {
    if (!email || !verifiedCode) return;
    setStep('submitting');
    try {
      const response = await fetch('/api/internal/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email,
          code: verifiedCode,
          password: data.password,
        }),
      });

      if (response.ok) {
        setStep('success');
        toast.success('Password reset successfully.');
        return;
      }

      const body = (await response.json().catch(() => ({}))) as ResetResponse;
      const errorCode = body.error?.code ?? 'invalid';

      if (errorCode === 'code_expired') {
        setStep('expired');
      } else if (errorCode === 'code_max_attempts') {
        setStep('max_attempts');
      } else if (errorCode === 'code_invalid') {
        setCodeError('Invalid code. Please check and try again.');
        setVerifiedCode('');
        setStep('code');
      } else {
        toast.error(body.error?.message ?? 'Reset failed. Please try again.');
        setVerifiedCode('');
        setStep('code');
      }
    } catch {
      toast.error('Something went wrong. Please try again.');
      setVerifiedCode('');
      setStep('code');
    }
  }

  async function handleResend() {
    if (!email) return;
    setResending(true);
    try {
      const response = await fetch('/api/internal/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });
      if (response.ok) {
        toast.success('A new reset code has been sent to your email.');
        setStep('code');
        setCodeError(undefined);
        setVerifiedCode('');
      } else {
        toast.error('Could not resend code. Please try again.');
      }
    } catch {
      toast.error('Could not resend code. Please try again.');
    } finally {
      setResending(false);
    }
  }

  if (step === 'no_email') {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Reset your password</CardTitle>
          <CardDescription className="text-[var(--color-danger)]">
            Missing email address. Please start from the forgot-password page.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button asChild>
            <Link href="/dashboard/forgot-password">Forgot password</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Reset your password</CardTitle>
        {step === 'code' && (
          <CardDescription>
            Enter the 6-digit code sent to{' '}
            <span className="font-medium text-[var(--color-fg)]">{email}</span>
          </CardDescription>
        )}
        {step === 'password' && <CardDescription>Choose a strong new password.</CardDescription>}
        {step === 'submitting' && <CardDescription>Resetting your password…</CardDescription>}
      </CardHeader>

      <CardContent>
        {step === 'code' && (
          <div className="space-y-6">
            <VerificationCodeInput
              onComplete={handleCodeComplete}
              error={codeError}
              autoFocus
            />
            {verifyingCode && (
              <p className="text-center text-xs text-[var(--color-muted)]">Verifying code…</p>
            )}
            <div className="text-center">
              <p className="text-xs text-[var(--color-muted)]">
                Didn&apos;t receive the code?{' '}
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resending || verifyingCode}
                  className="text-[var(--color-accent)] hover:underline disabled:opacity-50"
                >
                  {resending ? 'Sending...' : 'Resend code'}
                </button>
              </p>
            </div>
          </div>
        )}

        {(step === 'password' || step === 'submitting') && (
          <form
            id="dashboard-reset-password-form"
            noValidate
            onSubmit={handleSubmit(onSubmitPassword)}
            className="space-y-4"
          >
            <FormField
              label="New password"
              htmlFor="password"
              error={errors.password?.message}
              required
            >
              <PasswordInput
                id="password"
                placeholder="Enter new password"
                autoComplete="new-password"
                autoFocus
                disabled={step === 'submitting'}
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'password-error' : undefined}
                {...register('password')}
              />
            </FormField>

            <PasswordStrength password={passwordValue} />

            <FormField
              label="Confirm password"
              htmlFor="confirmPassword"
              error={errors.confirmPassword?.message}
              required
            >
              <PasswordInput
                id="confirmPassword"
                placeholder="Confirm new password"
                autoComplete="new-password"
                disabled={step === 'submitting'}
                aria-invalid={!!errors.confirmPassword}
                aria-describedby={
                  errors.confirmPassword ? 'confirmPassword-error' : undefined
                }
                {...register('confirmPassword')}
              />
            </FormField>

            <LoadingButton
              type="submit"
              loading={step === 'submitting'}
              loadingText="Resetting password..."
              className="w-full"
              disabled={
                step === 'submitting' ||
                (passwordValue.length > 0 && !isPasswordStrong(passwordValue))
              }
            >
              Reset password
            </LoadingButton>

            <div className="text-center">
              <button
                type="button"
                onClick={() => {
                  setVerifiedCode('');
                  setStep('code');
                }}
                className="text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:underline"
              >
                Re-enter code
              </button>
            </div>
          </form>
        )}

        {step === 'success' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <CheckCircle2
              className="h-10 w-10 text-[var(--color-success)]"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-[var(--color-success)]">
              Password reset successfully.
            </p>
            <Button asChild className="w-full">
              <Link href="/dashboard/login">Sign in with new password</Link>
            </Button>
          </div>
        )}

        {step === 'expired' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <Mail className="h-10 w-10 text-[var(--color-danger)]" aria-hidden="true" />
            <p className="text-sm text-[var(--color-danger)]">
              Your reset code has expired.
            </p>
            <LoadingButton
              onClick={handleResend}
              loading={resending}
              loadingText="Sending..."
              variant="outline"
            >
              Send a new code
            </LoadingButton>
          </div>
        )}

        {step === 'max_attempts' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <Mail className="h-10 w-10 text-[var(--color-danger)]" aria-hidden="true" />
            <p className="text-sm text-[var(--color-danger)]">
              Too many wrong attempts. This code has been invalidated.
            </p>
            <LoadingButton
              onClick={handleResend}
              loading={resending}
              loadingText="Sending..."
              variant="outline"
            >
              Send a new code
            </LoadingButton>
          </div>
        )}
      </CardContent>

      <CardFooter className="justify-center">
        <Link
          href="/dashboard/login"
          className="text-sm text-[var(--color-accent)] hover:underline"
        >
          Back to sign in
        </Link>
      </CardFooter>
    </Card>
  );
}

export default function DashboardResetPasswordPage() {
  return (
    <AuthShell>
      <Suspense
        fallback={
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-xl">Reset your password</CardTitle>
            </CardHeader>
            <CardContent className="flex justify-center py-8">
              <Loader2
                className="h-8 w-8 animate-spin text-[var(--color-accent)]"
                aria-hidden="true"
              />
            </CardContent>
          </Card>
        }
      >
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
