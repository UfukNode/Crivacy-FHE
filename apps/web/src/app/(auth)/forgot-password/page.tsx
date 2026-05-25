'use client';

import { useState } from 'react';
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
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/shared/form-field';
import { LoadingButton } from '@/components/shared/loading-button';
import { TurnstileWidget } from '@/components/shared/turnstile-widget';
import { EMAIL_MAX_LENGTH, emailSchema } from '@/lib/validation/auth';

const ForgotPasswordSchema = z.object({
  email: emailSchema,
  turnstileToken: z.string().optional(),
});

type ForgotPasswordFormData = z.infer<typeof ForgotPasswordSchema>;

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(ForgotPasswordSchema),
    defaultValues: {
      email: '',
      turnstileToken: '',
    },
  });

  async function onSubmit(data: ForgotPasswordFormData) {
    setLoading(true);
    try {
      const response = await fetch('/api/customer/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: data.email,
          turnstileToken: data.turnstileToken || undefined,
        }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string }; message?: string };
        const msg = body.error?.message ?? body.message ?? 'Request failed';
        throw new Error(msg);
      }

      // Always redirect to reset-password page with email pre-filled.
      // The API returns 200 regardless of whether the email exists (anti-enumeration).
      toast.success('If this email is registered, you will receive a reset code');
      router.push(`/reset-password?email=${encodeURIComponent(data.email)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Request failed';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Reset Password</CardTitle>
      </CardHeader>

      <CardContent>
        <form id="forgot-password-form" noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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

          <TurnstileWidget onSuccess={(token) => setValue('turnstileToken', token)} />

          <LoadingButton
            type="submit"
            loading={loading}
            loadingText="Sending code..."
            className="w-full"
          >
            Send reset code
          </LoadingButton>
        </form>
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
