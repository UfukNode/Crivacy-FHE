'use client';

import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/shared/form-field';
import { PasswordInput } from '@/components/shared/password-input';
import { PasswordStrength, isPasswordStrong } from '@/components/shared/password-strength';
import { LoadingButton } from '@/components/shared/loading-button';
import { TurnstileWidget } from '@/components/shared/turnstile-widget';
import { EMAIL_MAX_LENGTH, emailSchema, newPasswordSchema } from '@/lib/validation/auth';
import { displayNameSchema } from '@/lib/validation/profile';

const RegisterSchema = z.object({
  displayName: displayNameSchema.optional().or(z.literal('')),
  email: emailSchema,
  password: newPasswordSchema,
  turnstileToken: z.string().optional(),
  agreedToTerms: z.literal(true, {
    message: 'You must agree to the Terms of Service and Privacy Policy.',
  }),
});

type RegisterFormData = z.infer<typeof RegisterSchema>;

export default function RegisterPage() {
  // `useSearchParams` forces a client-bail during static prerender,
  // so wrap the form in a Suspense boundary, same shape Next 15
  // requires for the consent and login pages.
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Create Account</CardTitle>
          </CardHeader>
        </Card>
      }
    >
      <RegisterContent />
    </Suspense>
  );
}

function RegisterContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromParam = (searchParams?.get('from') ?? null);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<RegisterFormData>({
    resolver: zodResolver(RegisterSchema),
    defaultValues: {
      displayName: '',
      email: '',
      password: '',
      turnstileToken: '',
      // Intentionally `undefined` (not `false`) so the required-true
      // literal doesn't resolve until the user ticks the checkbox.
      agreedToTerms: undefined as unknown as true,
    },
  });

  const passwordValue = watch('password');

  async function onSubmit(data: RegisterFormData) {
    setLoading(true);
    try {
      const response = await fetch('/api/customer/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          displayName: data.displayName || undefined,
          email: data.email,
          password: data.password,
          turnstileToken: data.turnstileToken || undefined,
          agreedToTerms: data.agreedToTerms,
        }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string }; message?: string };
        const msg = body.error?.message ?? body.message ?? 'Registration failed';
        throw new Error(msg);
      }

      toast.success('Check your email for a verification code');
      // Redirect to verify-email page with email pre-filled. Forward
      // the mid-OAuth `from=` so the verify step can hop the user
      // back to the consent screen once the email is confirmed.
      const qs = new URLSearchParams({ email: data.email });
      if (fromParam !== null && fromParam.startsWith('/') && !fromParam.startsWith('//')) {
        qs.set('from', fromParam);
      }
      router.push(`/verify-email?${qs.toString()}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Create Account</CardTitle>
      </CardHeader>

      <CardContent>
        <form id="register-form" noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            label="Display name"
            htmlFor="displayName"
            error={errors.displayName?.message}
            description="Optional. How you want to be addressed."
          >
            <Input
              id="displayName"
              type="text"
              placeholder="John Doe"
              autoComplete="name"
              aria-invalid={!!errors.displayName}
              aria-describedby={errors.displayName ? 'displayName-error' : undefined}
              {...register('displayName')}
            />
          </FormField>

          <FormField
            label="Email"
            htmlFor="email"
            error={errors.email?.message}
            required
          >
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              maxLength={EMAIL_MAX_LENGTH}
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'email-error' : undefined}
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
              placeholder="Create a strong password"
              autoComplete="new-password"
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? 'password-error' : undefined}
              {...register('password')}
            />
          </FormField>

          <PasswordStrength password={passwordValue} />

          <TurnstileWidget onSuccess={(token) => setValue('turnstileToken', token)} />

          {/* AUD-X-COMP-006: explicit check-wrap consent. Required
              true, form submit blocked until the user ticks the box
              (client schema + server payload validator both enforce). */}
          <div className="space-y-1">
            <label className="flex items-start gap-2 text-xs text-[var(--color-muted)]">
              <input
                type="checkbox"
                className="mt-0.5 shrink-0 rounded border-[var(--color-border)]"
                aria-describedby={errors.agreedToTerms ? 'terms-error' : undefined}
                {...register('agreedToTerms')}
              />
              <span>
                I agree to the{' '}
                <Link
                  href="/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-accent)] hover:underline"
                >
                  Terms of Service
                </Link>{' '}
                and{' '}
                <Link
                  href="/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-accent)] hover:underline"
                >
                  Privacy Policy
                </Link>
                .
              </span>
            </label>
            {errors.agreedToTerms && (
              <p id="terms-error" className="text-xs text-[var(--color-danger)]">
                {errors.agreedToTerms.message}
              </p>
            )}
          </div>

          <LoadingButton
            type="submit"
            loading={loading}
            loadingText="Creating account..."
            className="w-full"
            disabled={loading || (passwordValue.length > 0 && !isPasswordStrong(passwordValue))}
          >
            Create account
          </LoadingButton>
        </form>

        {/* Separator */}
        <div className="relative my-4">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-[var(--color-border)]" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-[var(--color-surface)] px-2 text-[var(--color-muted)]">
              or continue with
            </span>
          </div>
        </div>

        {/* Google Sign-Up */}
        <LoadingButton
          type="button"
          variant="outline"
          loading={googleLoading}
          loadingText="Redirecting..."
          className="w-full"
          onClick={async () => {
            setGoogleLoading(true);
            try {
              // Forward `?from=` so the callback resumes the flow
              // that bounced the user onto the register page (e.g.
              // /oauth/consent or /docs/x).
              const initBody =
                fromParam !== null &&
                fromParam.startsWith('/') &&
                !fromParam.startsWith('//')
                  ? JSON.stringify({ from: fromParam })
                  : undefined;
              const res = await fetch('/api/customer/auth/google/initiate', {
                method: 'POST',
                credentials: 'include',
                ...(initBody !== undefined
                  ? {
                      headers: { 'Content-Type': 'application/json' },
                      body: initBody,
                    }
                  : {}),
              });
              if (!res.ok) {
                const body = (await res.json()) as { error?: { message?: string }; message?: string };
                throw new Error(body.error?.message ?? body.message ?? 'Google sign-up unavailable');
              }
              const data = (await res.json()) as { url: string };
              window.location.href = data.url;
            } catch (err) {
              const message = err instanceof Error ? err.message : 'Google sign-up failed';
              toast.error(message);
              setGoogleLoading(false);
            }
          }}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Google
        </LoadingButton>
      </CardContent>

      <CardFooter className="flex flex-col items-center gap-3">
        <p className="text-sm text-[var(--color-muted)]">
          Already have an account?{' '}
          <Link
            href={
              fromParam !== null ? `/login?from=${encodeURIComponent(fromParam)}` : '/login'
            }
            className="text-[var(--color-accent)] hover:underline"
          >
            Sign in
          </Link>
        </p>
        <RegisterCancelLink fromParam={fromParam} />
      </CardFooter>
    </Card>
  );
}

/**
 * Mid-OAuth escape hatch, same shape as the login page's version.
 * Shows a "cancel and return to partner" link when the registration
 * happened inside a larger `/oauth/consent` flow.
 */
function RegisterCancelLink({ fromParam }: { readonly fromParam: string | null }) {
  if (fromParam === null) return null;
  const match = fromParam.match(/^\/oauth\/consent\?request=([^&]+)/);
  if (match === null) return null;
  const requestId = decodeURIComponent(match[1] ?? '');
  if (requestId.length === 0) return null;
  // POST form (not <Link>) so Next.js prefetch + browser link-preview
  // bots cannot trigger the cancel handler before the user clicks.
  return (
    <form
      method="POST"
      action="/api/v1/oauth/authorize/cancel"
      className="inline"
    >
      <input type="hidden" name="request" value={requestId} />
      <button
        type="submit"
        className="cursor-pointer text-xs text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-fg)] hover:underline"
      >
        Cancel and return to the partner site
      </button>
    </form>
  );
}
