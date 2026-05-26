'use client';

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/shared/form-field';
import { PasswordInput } from '@/components/shared/password-input';
import { PasswordStrength, isPasswordStrong } from '@/components/shared/password-strength';
import { LoadingButton } from '@/components/shared/loading-button';
import { newPasswordSchema } from '@/lib/validation/auth';
import { displayNameSchema } from '@/lib/validation/profile';

const CompleteSchema = z.object({
  displayName: displayNameSchema.optional().or(z.literal('')),
  password: newPasswordSchema,
});

type CompleteFormData = z.infer<typeof CompleteSchema>;

export default function CompleteRegistrationPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [expired, setExpired] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<CompleteFormData>({
    resolver: zodResolver(CompleteSchema),
    defaultValues: {
      displayName: '',
      password: '',
    },
  });

  const passwordValue = watch('password');

  // Check if the completion cookie exists (rough check, actual verification is server-side)
  useEffect(() => {
    // If there's no cookie at all, the session probably expired
    // We can't read httpOnly cookies from JS, so we rely on the server
    // returning an error when we submit. This is just a UX hint.
  }, []);

  async function onSubmit(data: CompleteFormData) {
    setLoading(true);
    try {
      const response = await fetch('/api/customer/auth/google/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          password: data.password,
          displayName: data.displayName || undefined,
        }),
      });

      if (response.ok) {
        toast.success('Account created! Welcome to Crivacy.');
        router.push('/');
        return;
      }

      const body = (await response.json()) as { error?: { code?: string; message?: string }; message?: string };
      const errorCode = body.error?.code ?? body.message ?? '';
      const errorMsg = body.error?.message ?? body.message ?? 'Registration failed';

      if (errorCode === 'completion_token_expired' || errorCode === 'completion_token_invalid') {
        setExpired(true);
        return;
      }

      toast.error(errorMsg);
    } catch {
      toast.error('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (expired) {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Session expired</CardTitle>
          <CardDescription>
            Your registration session has expired. Please sign in with Google again.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Link
            href="/login"
            className="inline-flex h-9 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] transition-colors"
          >
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Complete your account</CardTitle>
        <CardDescription>
          Set a password to finish creating your Crivacy account
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form id="complete-form" noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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

          <LoadingButton
            type="submit"
            loading={loading}
            loadingText="Creating account..."
            className="w-full"
            disabled={loading || (passwordValue.length > 0 && !isPasswordStrong(passwordValue))}
          >
            Create account
          </LoadingButton>

          <p className="text-center text-xs text-[var(--color-muted)]">
            By creating an account, you agree to our{' '}
            <Link href="/terms" className="text-[var(--color-accent)] hover:underline" target="_blank" rel="noopener noreferrer">
              Terms of Service
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="text-[var(--color-accent)] hover:underline" target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </Link>.
          </p>
        </form>
      </CardContent>

      <CardFooter className="justify-center">
        <p className="text-sm text-[var(--color-muted)]">
          Already have an account?{' '}
          <Link href="/login" className="text-[var(--color-accent)] hover:underline">
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
