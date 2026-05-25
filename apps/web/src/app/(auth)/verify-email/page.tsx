'use client';

import { useState, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
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
import { VerificationCodeInput } from '@/components/shared/verification-code-input';
import { LoadingButton } from '@/components/shared/loading-button';

type VerifyStatus =
  | 'entering'
  | 'verifying'
  | 'verified'
  | 'already_verified'
  | 'expired'
  | 'invalid'
  | 'max_attempts'
  | 'no_email';

interface VerifyResponse {
  status?: string;
  error?: { code?: string; message?: string };
  message?: string;
}

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const email = (searchParams?.get('email') ?? null);
  const [status, setStatus] = useState<VerifyStatus>(email ? 'entering' : 'no_email');
  const [codeError, setCodeError] = useState<string | undefined>();
  const [resending, setResending] = useState(false);

  const verifyCode = useCallback(
    async (code: string) => {
      if (!email) return;
      setStatus('verifying');
      setCodeError(undefined);

      try {
        const response = await fetch('/api/customer/auth/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, code }),
        });

        if (response.ok) {
          const body = (await response.json()) as VerifyResponse;
          if (body.status === 'already_verified') {
            setStatus('already_verified');
          } else {
            setStatus('verified');
            toast.success('Email verified! Redirecting to login...');
            // Preserve the `from` that register was invoked with
            // (e.g. `/oauth/consent?request=…`) so the user lands
            // back on the partner flow after sign-in instead of
            // the dashboard root.
            const postFrom = (searchParams?.get('from') ?? null);
            const loginTarget =
              postFrom !== null && postFrom.startsWith('/') && !postFrom.startsWith('//')
                ? `/login?from=${encodeURIComponent(postFrom)}`
                : '/login';
            setTimeout(() => {
              router.push(loginTarget);
            }, 2000);
          }
          return;
        }

        const body = (await response.json()) as VerifyResponse;
        const errorCode = body.error?.code ?? body.message ?? 'invalid';

        if (errorCode === 'code_expired') {
          setStatus('expired');
        } else if (errorCode === 'code_max_attempts') {
          setStatus('max_attempts');
        } else if (errorCode === 'code_invalid') {
          setCodeError('Invalid code. Please try again.');
          setStatus('entering');
        } else {
          setCodeError('Invalid code. Please try again.');
          setStatus('entering');
        }
      } catch {
        setCodeError('Something went wrong. Please try again.');
        setStatus('entering');
      }
    },
    [email, router],
  );

  async function handleResend() {
    if (!email) return;
    setResending(true);
    try {
      const response = await fetch('/api/customer/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });

      if (response.ok) {
        toast.success('A new code has been sent to your email');
        setStatus('entering');
        setCodeError(undefined);
      } else {
        const body = (await response.json()) as VerifyResponse;
        const msg = body.error?.message ?? body.message ?? 'Could not resend code';
        toast.error(msg);
      }
    } catch {
      toast.error('Could not resend code. Please try again.');
    } finally {
      setResending(false);
    }
  }

  // No email in URL, invalid access
  if (status === 'no_email') {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Verify your email</CardTitle>
          <CardDescription className="text-[var(--color-danger)]">
            Missing email address. Please register first.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button asChild>
            <Link href="/register">Go to register</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Verify your email</CardTitle>
        {(status === 'entering' || status === 'verifying') && (
          <CardDescription>
            We sent a 6-digit code to{' '}
            <span className="font-medium text-[var(--color-fg)]">{email}</span>
          </CardDescription>
        )}
      </CardHeader>

      <CardContent>
        {/* Entering code / Verifying */}
        {(status === 'entering' || status === 'verifying') && (
          <div className="space-y-6">
            <VerificationCodeInput
              onComplete={verifyCode}
              error={codeError}
              disabled={status === 'verifying'}
              autoFocus
            />

            {status === 'verifying' && (
              <div className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-[var(--color-accent)]" aria-hidden="true" />
                <p className="text-sm text-[var(--color-muted)]">Verifying...</p>
              </div>
            )}

            <div className="text-center">
              <p className="text-xs text-[var(--color-muted)]">
                Didn&apos;t receive the code?{' '}
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resending}
                  className="text-[var(--color-accent)] hover:underline disabled:opacity-50"
                >
                  {resending ? 'Sending...' : 'Resend code'}
                </button>
              </p>
            </div>
          </div>
        )}

        {/* Verified */}
        {status === 'verified' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <CheckCircle2 className="h-10 w-10 text-[var(--color-success)]" aria-hidden="true" />
            <p className="text-sm font-medium text-[var(--color-success)]">
              Email verified successfully!
            </p>
            <p className="text-xs text-[var(--color-muted)]">Redirecting to login...</p>
          </div>
        )}

        {/* Already verified */}
        {status === 'already_verified' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <CheckCircle2 className="h-10 w-10 text-[var(--color-success)]" aria-hidden="true" />
            <p className="text-sm text-[var(--color-fg)]">Your email is already verified.</p>
            <Button asChild>
              <Link href="/login">Go to login</Link>
            </Button>
          </div>
        )}

        {/* Code expired */}
        {status === 'expired' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <Mail className="h-10 w-10 text-[var(--color-danger)]" aria-hidden="true" />
            <p className="text-sm text-[var(--color-danger)]">
              Your verification code has expired.
            </p>
            <LoadingButton
              onClick={handleResend}
              loading={resending}
              loadingText="Sending..."
              variant="outline"
            >
              Resend code
            </LoadingButton>
          </div>
        )}

        {/* Max attempts */}
        {status === 'max_attempts' && (
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
        <p className="text-sm text-[var(--color-muted)]">
          Wrong email?{' '}
          <Link href="/register" className="text-[var(--color-accent)] hover:underline">
            Go back
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Verify your email</CardTitle>
          </CardHeader>
          <CardContent className="flex justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-[var(--color-accent)]" aria-hidden="true" />
          </CardContent>
        </Card>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}
