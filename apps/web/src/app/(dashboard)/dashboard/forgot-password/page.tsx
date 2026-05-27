'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AuthShell } from '@/components/shared/auth-shell';
import { FormField } from '@/components/shared/form-field';
import { LoadingButton } from '@/components/shared/loading-button';
import { EMAIL_MAX_LENGTH, emailSchema } from '@/lib/validation/auth';

/**
 * Firm-dashboard forgot-password entry page.
 *
 * Submits an email to `/api/internal/auth/forgot-password`. The API
 * always responds 200 (anti-enumeration) so on success we push the
 * user to the reset page with the email prefilled, matching the
 * customer flow shape exactly. The backend silently no-ops if the
 * address doesn't resolve to an active firm user.
 */

const ForgotPasswordSchema = z.object({
  email: emailSchema,
});

type ForgotPasswordFormData = z.infer<typeof ForgotPasswordSchema>;

export default function DashboardForgotPasswordPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(ForgotPasswordSchema),
    defaultValues: { email: '' },
  });

  async function onSubmit(data: ForgotPasswordFormData) {
    setLoading(true);
    try {
      const response = await fetch('/api/internal/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: data.email }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(body.error?.message ?? 'Request failed.');
      }

      toast.success('If this email is registered, you will receive a reset code.');
      router.push(`/dashboard/reset-password?email=${encodeURIComponent(data.email)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell>
      <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Reset your password</CardTitle>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              We&apos;ll email a 6-digit code so you can choose a new password.
            </p>
          </CardHeader>

          <CardContent>
            <form
              id="dashboard-forgot-password-form"
              noValidate
              onSubmit={handleSubmit(onSubmit)}
              className="space-y-4"
            >
              <FormField label="Email" htmlFor="email" error={errors.email?.message} required>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@company.com"
                  autoComplete="email"
                  autoFocus
                  maxLength={EMAIL_MAX_LENGTH}
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? 'email-error' : undefined}
                  disabled={loading}
                  {...register('email')}
                />
              </FormField>

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
              href="/dashboard/login"
              className="text-sm text-[var(--color-accent)] hover:underline"
            >
              Back to sign in
            </Link>
          </CardFooter>
        </Card>
    </AuthShell>
  );
}
