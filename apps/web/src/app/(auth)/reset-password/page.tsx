'use client';

import { useState, useCallback, Suspense } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, CheckCircle2, Mail } from 'lucide-react';

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/shared/form-field';
import { PasswordInput } from '@/components/shared/password-input';
import { PasswordStrength, isPasswordStrong } from '@/components/shared/password-strength';
import { LoadingButton } from '@/components/shared/loading-button';
import { VerificationCodeInput } from '@/components/shared/verification-code-input';
import { newPasswordSchema } from '@/lib/validation/auth';

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

type ResetStep = 'code' | 'password' | 'submitting' | 'success' | 'expired' | 'max_attempts' | 'no_email';

interface ResetResponse {
  status?: string;
  error?: { code?: string; message?: string };
  message?: string;
}

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const email = (searchParams?.get('email') ?? null);
  const [step, setStep] = useState<ResetStep>(email ? 'code' : 'no_email');
  const [codeError, setCodeError] = useState<string | undefined>();
  const [verifiedCode, setVerifiedCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<NewPasswordFormData>({
    resolver: zodResolver(NewPasswordSchema),
    defaultValues: {
      password: '',
      confirmPassword: '',
    },
  });

  const passwordValue = watch('password');

  // Step 1: User enters 6-digit code → hit verify endpoint first,
  // only advance on server-confirmed valid code. Old implementation
  // took any 6 digits and deferred validation to the final reset
  // POST, which made stale / fake codes look "accepted" in the UI.
  const handleCodeComplete = useCallback(
    async (code: string) => {
      if (!email) return;
      setVerifyingCode(true);
      try {
        const response = await fetch('/api/customer/auth/verify-reset-code', {
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

  // Step 2: User enters new password → submit code + password to API
  async function onSubmitPassword(data: NewPasswordFormData) {
    if (!email || !verifiedCode) return;

    setLoading(true);
    setStep('submitting');
    try {
      const response = await fetch('/api/customer/auth/reset-password', {
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
        toast.success('Password reset successfully!');
        return;
      }

      const body = (await response.json()) as ResetResponse;
      const errorCode = body.error?.code ?? body.message ?? 'invalid';

      if (errorCode === 'code_expired') {
        setStep('expired');
      } else if (errorCode === 'code_max_attempts') {
        setStep('max_attempts');
      } else if (errorCode === 'code_invalid') {
        // Code was wrong, go back to code entry
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
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (!email) return;
    setResending(true);
    try {
      const response = await fetch('/api/customer/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });

      if (response.ok) {
        toast.success('A new reset code has been sent to your email');
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

  // No email in URL
  if (step === 'no_email') {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Reset your password</CardTitle>
          <CardDescription className="text-[var(--color-danger)]">
            Missing email address. Please start from the forgot password page.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button asChild>
            <Link href="/forgot-password">Forgot password</Link>
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
        {step === 'password' && (
          <CardDescription>Choose a strong new password</CardDescription>
        )}
        {step === 'submitting' && (
          <CardDescription>Resetting your password...</CardDescription>
        )}
      </CardHeader>

      <CardContent>
        {/* Step 1: Code entry */}
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

        {/* Step 2: New password */}
        {(step === 'password' || step === 'submitting') && (
          <form id="reset-password-form" noValidate onSubmit={handleSubmit(onSubmitPassword)} className="space-y-4">
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
                aria-describedby={errors.confirmPassword ? 'confirmPassword-error' : undefined}
                {...register('confirmPassword')}
              />
            </FormField>

            <LoadingButton
              type="submit"
              loading={step === 'submitting'}
              loadingText="Resetting password..."
              className="w-full"
              disabled={step === 'submitting' || (passwordValue.length > 0 && !isPasswordStrong(passwordValue))}
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

        {/* Success */}
        {step === 'success' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <CheckCircle2 className="h-10 w-10 text-[var(--color-success)]" aria-hidden="true" />
            <p className="text-sm font-medium text-[var(--color-success)]">
              Password reset successfully!
            </p>
            <Button asChild className="w-full">
              <Link href="/login">Sign in with new password</Link>
            </Button>
          </div>
        )}

        {/* Code expired */}
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

        {/* Max attempts */}
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
          href="/login"
          className="text-sm text-[var(--color-accent)] hover:underline"
        >
          Back to sign in
        </Link>
      </CardFooter>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Reset your password</CardTitle>
          </CardHeader>
          <CardContent className="flex justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-[var(--color-accent)]" aria-hidden="true" />
          </CardContent>
        </Card>
      }
    >
      <ResetPasswordContent />
    </Suspense>
  );
}
