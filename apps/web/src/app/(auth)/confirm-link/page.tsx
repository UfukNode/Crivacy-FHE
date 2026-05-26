'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
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
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { FormField } from '@/components/shared/form-field';
import { PasswordInput } from '@/components/shared/password-input';
import { LoadingButton } from '@/components/shared/loading-button';
import { existingPasswordSchema } from '@/lib/validation/auth';

/**
 * F-A2-C2-001 confirm-link page. The OAuth callback's auto-link
 * branch redirects here with `?t=<token>` after a Google sign-in
 * matches an existing Crivacy email. The user supplies their
 * current password to prove ownership before the link is committed
 *, closing the silent-auto-link takeover hole that previously
 * existed.
 */

const ConfirmSchema = z.object({
  currentPassword: existingPasswordSchema,
});

type ConfirmFormData = z.infer<typeof ConfirmSchema>;

interface DecodedTokenInfo {
  readonly email: string;
  readonly displayName: string;
}

/**
 * Decode the email + name claims from the JWT for display only.
 * The token's signature is server-validated when the form is
 * submitted; this read is purely cosmetic, so a malformed payload
 * just means the page falls back to a generic message.
 */
function peekTokenInfo(token: string): DecodedTokenInfo | null {
  try {
    const segments = token.split('.');
    if (segments.length !== 3) return null;
    const payloadSegment = segments[1];
    if (!payloadSegment) return null;
    // base64url → base64
    const padded = payloadSegment
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(payloadSegment.length + ((4 - (payloadSegment.length % 4)) % 4), '=');
    const json = atob(padded);
    const obj = JSON.parse(json) as { email?: unknown; name?: unknown };
    if (typeof obj.email !== 'string') return null;
    return {
      email: obj.email,
      displayName: typeof obj.name === 'string' && obj.name.length > 0 ? obj.name : obj.email,
    };
  } catch {
    return null;
  }
}

function ConfirmLinkContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [expired, setExpired] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState(false);

  const token = (searchParams?.get('t') ?? null);
  const continueParam = (searchParams?.get('continue') ?? null);

  const tokenInfo = useMemo(() => (token !== null ? peekTokenInfo(token) : null), [token]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ConfirmFormData>({
    resolver: zodResolver(ConfirmSchema),
    defaultValues: { currentPassword: '' },
  });

  // Token absent or unparseable → expired UI immediately.
  useEffect(() => {
    if (token === null || token.length === 0) setExpired(true);
  }, [token]);

  async function onSubmit(data: ConfirmFormData) {
    if (token === null) return;
    setLoading(true);
    try {
      const response = await fetch('/api/customer/auth/google/confirm-link', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          currentPassword: data.currentPassword,
          ...(continueParam !== null && continueParam.length > 0 ? { continueTo: continueParam } : {}),
        }),
      });

      if (response.ok) {
        const body = (await response.json()) as { redirect?: string };
        toast.success('Google linked. Welcome back!');
        router.push(body.redirect ?? '/');
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;
      const code = body?.error?.code ?? '';
      const msg = body?.error?.message ?? 'Could not confirm the link. Please try again.';

      if (code === 'invalid_verification_token') {
        setExpired(true);
        return;
      }
      if (code === 'conflict') {
        // Reauth gate returned password_not_set, wallet-only-with-
        // email account. Surface a clear path: sign in with wallet,
        // then link Google from settings.
        setPasswordRequired(true);
        return;
      }
      toast.error(msg);
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
          <CardTitle className="text-xl">Confirmation expired</CardTitle>
          <CardDescription>
            This link has expired or is no longer valid. Please start the Google sign-in flow again.
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

  if (passwordRequired) {
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Sign in with your wallet first</CardTitle>
          <CardDescription>
            This account uses Ethereum Wallet for sign-in. Sign in with your wallet, then
            link Google from <span className="font-medium">Settings → Security</span>.
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
        <CardTitle className="text-xl">Confirm your account</CardTitle>
        <CardDescription>
          {tokenInfo === null ? (
            <>Enter your current password to link Google to your Crivacy account.</>
          ) : (
            <>
              We found a Crivacy account for{' '}
              <span className="font-medium text-[var(--color-fg)]">{tokenInfo.email}</span>.
              Enter your current password to link Google.
            </>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form id="confirm-link-form" noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            label="Current password"
            htmlFor="confirm-link-password"
            error={errors.currentPassword?.message}
            required
          >
            <PasswordInput
              id="confirm-link-password"
              placeholder="Your Crivacy password"
              autoComplete="current-password"
              aria-invalid={!!errors.currentPassword}
              {...register('currentPassword')}
            />
          </FormField>

          <LoadingButton
            type="submit"
            loading={loading}
            loadingText="Linking…"
            className="w-full"
            disabled={loading}
          >
            Link Google &amp; sign in
          </LoadingButton>
        </form>
      </CardContent>

      <CardFooter className="justify-center">
        <p className="text-sm text-[var(--color-muted)]">
          Not your account?{' '}
          <Link href="/login" className="text-[var(--color-accent)] hover:underline">
            Cancel
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}

export default function ConfirmLinkPage() {
  return (
    <Suspense fallback={null}>
      <ConfirmLinkContent />
    </Suspense>
  );
}
