'use client';

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Suspense } from 'react';

import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { FormField } from '@/components/shared/form-field';
import { PasswordInput } from '@/components/shared/password-input';
import { LoadingButton } from '@/components/shared/loading-button';
import { TurnstileWidget } from '@/components/shared/turnstile-widget';
import { sanitizeSameOriginPath } from '@/lib/security/safe-redirect';
import { EMAIL_MAX_LENGTH, emailSchema, existingPasswordSchema } from '@/lib/validation/auth';

const LoginSchema = z.object({
  email: emailSchema,
  password: existingPasswordSchema,
  rememberMe: z.boolean(),
  turnstileToken: z.string().min(1, 'Captcha verification is required.'),
});

type LoginFormData = z.infer<typeof LoginSchema>;

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [walletLoading, setWalletLoading] = useState(false);
  // Form-level live region content. Mirrors whatever ends up in the
  // Sonner toast for assistive tech, the toast is visual feedback;
  // this string is what `aria-live="polite"` announces to screen
  // readers. Empty string keeps the region quiet on mount.
  const [formError, setFormError] = useState('');

  // Show toast for session-related redirects and OAuth errors
  useEffect(() => {
    const reason = (searchParams?.get('reason') ?? null);
    const error = (searchParams?.get('error') ?? null);
    if (reason === 'session_expired') {
      toast.info('Your session has expired. Please sign in again.');
    } else if (reason === 'session_superseded') {
      toast.info('You were signed out because you logged in on another device.');
    }
    if (error === 'oauth_failed') {
      const msg = 'Google sign-in failed. Please try again or use email and password.';
      toast.error(msg);
      setFormError(msg);
    } else if (error === 'account_banned') {
      const msg = 'Account has been banned. Please contact support.';
      toast.error(msg);
      setFormError(msg);
    } else if (error === 'account_suspended') {
      const msg = 'Account is suspended. Contact support to review the restriction.';
      toast.error(msg);
      setFormError(msg);
    } else if (error === 'account_locked') {
      const msg = 'Account is temporarily locked due to too many failed attempts. Please try again later.';
      toast.error(msg);
      setFormError(msg);
    }
  }, [searchParams]);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(LoginSchema),
    defaultValues: {
      email: '',
      password: '',
      rememberMe: false,
      turnstileToken: '',
    },
  });

  const rememberMeValue = watch('rememberMe');

  async function onSubmit(data: LoginFormData) {
    setLoading(true);
    // Clear stale form-level error so the live region only announces
    // the outcome of THIS submission attempt.
    setFormError('');
    try {
      const response = await fetch('/api/customer/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: data.email,
          password: data.password,
          rememberMe: data.rememberMe,
          turnstileToken: data.turnstileToken,
        }),
      });

      if (!response.ok) {
        const body = (await response.json()) as {
          error?: { code?: string; message?: string };
          message?: string;
        };
        const errorCode = body.error?.code ?? '';
        const msg = body.error?.message ?? body.message ?? 'Login failed';

        // Email not verified, redirect to verification page. Keep
        // `loading` ON because we're navigating away; clearing it
        // would let the user fire a second login before the
        // verification page mounts.
        if (errorCode === 'email_not_verified') {
          toast.info('Please verify your email first');
          router.push(`/verify-email?email=${encodeURIComponent(data.email)}`);
          return;
        }

        throw new Error(msg);
      }

      // Redirect to the page they came from, or home. The `from`
      // value comes from the middleware (unauthenticated access gets
      // bounced to `/login?from=<path>`), so normally it's a safe
      // relative path. We still validate it to stop an open-redirect
      // attack if a user is tricked into clicking
      // `/login?from=//evil.example.com`: it must start with exactly
      // one `/` so it stays on our origin.
      //
      // `router.push` is async soft navigation, it returns before
      // the destination mounts. Leaving `loading` ON until the page
      // unloads closes the "button re-enabled mid-navigation"
      // window that otherwise would let the user (or a double-click)
      // fire a second login request against the already-issued
      // session cookie.
      const from = (searchParams?.get('from') ?? null);
      const safeFrom = sanitizeSameOriginPath(from);
      router.push(safeFrom);
    } catch (err) {
      // Browsers throw `TypeError: Failed to fetch` for CORS / DNS /
      // offline / connection-reset failures, surface a copy that
      // tells the user what to do, instead of leaking the raw
      // platform message into the toast.
      let message: string;
      if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
        message = 'Network error. Please check your connection and try again.';
      } else {
        message = err instanceof Error ? err.message : 'Login failed';
      }
      toast.error(message);
      setFormError(message);
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="text-center">
        {/* Page heading. CardTitle ships as a `<div>` (see ui/card.tsx)
            which leaves the auth pages without a top-level heading;
            screen readers + WCAG 2.4.6 want one `<h1>` per route, and
            the SkipNav target lands here on Tab. The Tailwind classes
            mirror CardTitle's defaults plus the `text-xl` page
            override so the visual size is unchanged from the previous
            CardTitle render. */}
        <h1 className="text-xl font-semibold leading-none tracking-tight">Sign in</h1>
      </CardHeader>

      <CardContent>
        <form
          id="login-form"
          noValidate
          method="post"
          onSubmit={handleSubmit(onSubmit)}
          aria-describedby="login-form-errors"
          className="space-y-4"
        >
          {/* Form-level live region. Empty string keeps it silent on
              mount; updates via `setFormError(...)` announce through
              `aria-live="polite"`. Field-level errors continue to
              render under each input via FormField's own
              `role="alert"`. `method="post"` is defensive depth, the
              `onSubmit` handler always preventDefault's, but a no-JS
              fallback would otherwise default to GET and leak
              credentials in the URL. */}
          <div
            id="login-form-errors"
            role="alert"
            aria-live="polite"
            className="sr-only"
          >
            {formError}
          </div>
          <FormField label="Email" htmlFor="email" error={errors.email?.message} required>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              maxLength={EMAIL_MAX_LENGTH}
              spellCheck={false}
              required
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'email-error' : undefined}
              {...register('email')}
            />
          </FormField>

          <FormField label="Password" htmlFor="password" error={errors.password?.message} required>
            <PasswordInput
              id="password"
              placeholder="Enter your password"
              autoComplete="current-password"
              required
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? 'password-error' : undefined}
              {...register('password')}
            />
          </FormField>

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
              href="/forgot-password"
              className="inline-flex min-h-[44px] items-center text-sm text-[var(--color-accent)] hover:underline"
            >
              Forgot password?
            </Link>
          </div>

          <TurnstileWidget onSuccess={(token) => setValue('turnstileToken', token)} />

          <LoadingButton
            type="submit"
            loading={loading}
            loadingText="Signing in..."
            className="w-full"
          >
            Sign in
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

        {/* Google Sign-In */}
        <LoadingButton
          type="button"
          variant="outline"
          loading={googleLoading}
          loadingText="Redirecting..."
          className="w-full"
          onClick={async () => {
            setGoogleLoading(true);
            try {
              // Forward the current `?from=` so the callback lands
              // the user back where they started (e.g. /docs/x or
              // an /oauth/consent request). The initiate endpoint
              // re-validates same-origin before embedding it in the
              // signed state JWT.
              const fromParam = (searchParams?.get('from') ?? null);
              const safeInit = sanitizeSameOriginPath(fromParam);
              const initBody = safeInit !== '/' ? JSON.stringify({ from: safeInit }) : undefined;
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
                const body = (await res.json()) as {
                  error?: { message?: string };
                  message?: string;
                };
                throw new Error(
                  body.error?.message ?? body.message ?? 'Google sign-in unavailable',
                );
              }
              const data = (await res.json()) as { url: string };
              window.location.replace(data.url);
            } catch (err) {
              const message = err instanceof Error ? err.message : 'Google sign-in failed';
              toast.error(message);
              setFormError(message);
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

        {/* Ethereum Wallet (Sign-In With Ethereum) */}
        <LoadingButton
          type="button"
          variant="outline"
          loading={walletLoading}
          loadingText="Connecting wallet..."
          className="mt-4 w-full"
          onClick={async () => {
            setWalletLoading(true);
            try {
              // 1. Injected EVM wallet (MetaMask / Rabby / …)
              const eth = (
                window as unknown as {
                  ethereum?: {
                    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
                  };
                }
              ).ethereum;
              if (eth === undefined) {
                toast.error('No EVM wallet detected. Install MetaMask or a compatible wallet.');
                return;
              }

              // 2. Connect + read the selected account
              const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
              const address = accounts[0];
              if (address === undefined) {
                toast.error('Wallet connection was rejected.');
                return;
              }

              // 3. Get a nonce from the server
              const challengeRes = await fetch('/api/customer/auth/wallet/challenge', {
                method: 'POST',
                credentials: 'include',
              });
              if (!challengeRes.ok) {
                throw new Error('Failed to get wallet challenge');
              }
              const { challenge, nonce } = (await challengeRes.json()) as {
                challenge: string;
                nonce: string;
              };

              // 4. Build the EIP-4361 (SIWE) message
              const { createSiweMessage } = await import('viem/siwe');
              const message = createSiweMessage({
                address: address as `0x${string}`,
                chainId: 11155111,
                domain: window.location.host,
                nonce,
                uri: window.location.origin,
                version: '1',
                statement: 'Sign in to Crivacy with your Ethereum wallet.',
              });

              // 5. Sign it (personal_sign)
              const signature = (await eth.request({
                method: 'personal_sign',
                params: [message, address],
              })) as string;
              if (!signature) {
                toast.error('Message signing was rejected.');
                return;
              }

              // 6. Verify with server, forward `?from=` when
              // present so the wallet login routes the user back
              // to the page that bounced them onto /login.
              const walletFrom = (searchParams?.get('from') ?? null);
              const safeWalletFrom = sanitizeSameOriginPath(walletFrom);
              const verifyRes = await fetch('/api/customer/auth/wallet/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                  challenge,
                  message,
                  signature,
                  provider: 'evm_wallet',
                  ...(safeWalletFrom !== '/' ? { from: safeWalletFrom } : {}),
                }),
              });

              if (!verifyRes.ok) {
                const body = (await verifyRes.json()) as { error?: { message?: string } };
                throw new Error(body.error?.message ?? 'Wallet verification failed');
              }

              const data = (await verifyRes.json()) as { redirect: string };
              window.location.href = data.redirect;
            } catch (err) {
              const message = err instanceof Error ? err.message : 'Wallet sign-in failed';
              toast.error(message);
              setFormError(message);
            } finally {
              setWalletLoading(false);
            }
          }}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
            <path d="M3 10h18" stroke="currentColor" strokeWidth="2" />
            <circle cx="17" cy="14" r="1" fill="currentColor" />
          </svg>
          Ethereum Wallet
        </LoadingButton>
      </CardContent>

      <CardFooter className="flex flex-col items-center gap-3">
        <p className="text-sm text-[var(--color-muted)]">
          Don&apos;t have an account?{' '}
          <Link
            href={
              (searchParams?.get('from') ?? null) !== null
                ? `/register?from=${encodeURIComponent((searchParams?.get('from') ?? null) ?? '/')}`
                : '/register'
            }
            className="inline-flex min-h-[44px] items-center text-[var(--color-accent)] hover:underline"
          >
            Sign up
          </Link>
        </p>
        <OauthCancelLink fromParam={(searchParams?.get('from') ?? null)} />
      </CardFooter>
    </Card>
  );
}

/**
 * If the user is here mid-OAuth flow (their `from=` points at the
 * consent page with a request id), give them a one-click way out
 * that sends the standard `error=access_denied` back to the firm's
 * callback. Otherwise render nothing.
 */
function OauthCancelLink({ fromParam }: { readonly fromParam: string | null }) {
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

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader className="text-center">
            <h1 className="text-xl font-semibold leading-none tracking-tight">Sign in</h1>
          </CardHeader>
        </Card>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
