'use client';

/**
 * OAuth consent screen.
 *
 * Route: `/oauth/consent?request=<id>`.
 *
 * The page fetches its data from `/api/v1/oauth/consent/bootstrap`,
 * which doubles as the auth gate, a 401 response tells us the
 * user isn't logged in, at which point we bounce them to `/login`
 * with a `continue` parameter that lands them back here afterwards.
 *
 * Approve → POST `/api/v1/oauth/consent`, receive a redirect URL,
 * navigate. Reject → same POST with decision=reject.
 */

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { CrivacyLogo } from '@/components/shared/crivacy-logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useKycEvents } from '@/hooks/use-kyc-events';

type KycLevelWire = 'basic' | 'enhanced' | null;

interface BootstrapResponse {
  readonly request: {
    readonly id: string;
    readonly scope: string;
    readonly scopes: ReadonlyArray<{
      readonly id: string;
      readonly description: string;
      readonly requiredLevel: KycLevelWire;
    }>;
    readonly redirectUri: string;
    readonly expiresAt: string;
    readonly requiredLevel: KycLevelWire;
  };
  readonly client: {
    readonly name: string;
    readonly description: string | null;
    readonly logoUrl: string | null;
    readonly homepageUrl: string | null;
  };
  readonly user: {
    readonly id: string;
    readonly email: string | null;
    readonly kycLevel: string;
    readonly credentialLevel: KycLevelWire;
  };
  readonly kycGate: {
    readonly needsKyc: boolean;
    readonly needsKycUpgrade: boolean;
    readonly missingScopes: readonly string[];
  };
  readonly cachedConsent: {
    readonly id: string;
    readonly grantedAt: string;
    readonly expiresAt: string;
  } | null;
}

interface ErrorShape {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

/** `approved | rejected | expired | revoked` on the firm callback. */
type CallbackError = 'access_denied' | 'login_required' | 'temporarily_unavailable';

/**
 * Client entry point for the consent surface. Accepts the bootstrap
 * data pre-fetched by the server component so the first paint lands
 * on the real consent card (or a real error), never on a skeleton
 * flash. `Suspense` is no longer needed because we don't rely on
 * `useSearchParams()` triggering a prerender bailout, the server
 * passes `requestId` down explicitly.
 */
export default function ConsentClient({
  requestId,
  initialBootstrap,
  initialError,
}: {
  requestId: string;
  initialBootstrap: BootstrapResponse | null;
  initialError: ErrorShape | null;
}) {
  return (
    <OauthConsentInner
      requestId={requestId}
      initialBootstrap={initialBootstrap}
      initialError={initialError}
    />
  );
}

function OauthConsentInner({
  requestId,
  initialBootstrap,
  initialError,
}: {
  requestId: string;
  initialBootstrap: BootstrapResponse | null;
  initialError: ErrorShape | null;
}) {
  const router = useRouter();

  const [data, setData] = useState<BootstrapResponse | null>(initialBootstrap);
  const [error, setError] = useState<ErrorShape | null>(initialError);
  // We START with `loading=false` because the server already loaded
  // the bootstrap (or surfaced an error). The only path that flips it
  // back to `true` is the decision submit below, which has its own
  // `submitting` flag, so `loading` stays false for the rest of this
  // page's lifetime.
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState<false | 'approve' | 'reject' | 'start_kyc'>(false);

  // Redirect to login carrying the original authorize URL so the
  // user lands back on the consent page after signing in. The
  // login page honours `?from=<path>` for same-origin post-login
  // redirects, keep the parameter name consistent so the middleware
  // and the consent flow share one convention.
  const redirectToLogin = useCallback(() => {
    if (requestId === null) return;
    const returnPath = `/oauth/consent?request=${encodeURIComponent(requestId)}`;
    router.replace(`/login?from=${encodeURIComponent(returnPath)}`);
  }, [requestId, router]);

  // Intentionally no effect-driven fetch here. The server component
  // pre-loaded `initialBootstrap` / `initialError`, so there is
  // nothing left to do on mount. A stale-data re-fetch could be
  // added later, but the bootstrap is short-lived (15-min request
  // TTL) so it's never "stale enough" to justify the extra round
  // trip and accompanying flash.

  // SSE listener for real-time credential arrival. Only subscribe
  // while the KYC gate is up, once the user has an active
  // credential, the next page state transition is user-driven (they
  // click Approve / Decline), not webhook-driven. The `useKycEvents`
  // hook disconnects cleanly when `enabled` flips false.
  //
  // `credential.issued` is the signal we actually care about: Didit
  // webhook landed, the credential row exists, the gate would now
  // return `needsKyc = false`. Refreshing the route re-runs the
  // server-side bootstrap and the gate check, the approve branch
  // lights up without the user having to do anything.
  const waitingForCredential =
    data !== null && (data.kycGate.needsKyc || data.kycGate.needsKycUpgrade);
  useKycEvents(
    (eventType) => {
      if (eventType === 'credential.issued') {
        router.refresh();
      }
    },
    waitingForCredential,
  );

  async function startKyc(): Promise<void> {
    if (requestId === null) return;
    setSubmitting('start_kyc');

    // Resetting the button after 10s prevents a stranded spinner on
    // a flaky network, user can retry rather than staring at it.
    const stuckTimer = setTimeout(() => {
      setSubmitting(false);
      setError({
        code: 'slow_response',
        message:
          'Starting verification took longer than expected. Try again or reload the page.',
        status: 0,
      });
    }, 10_000);

    try {
      const res = await fetch('/api/customer/kyc/start-from-consent', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId }),
      });
      clearTimeout(stuckTimer);

      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        setSubmitting(false);
        setError({
          code: body?.error?.code ?? 'unknown',
          message: body?.error?.message ?? 'Could not start verification.',
          status: res.status,
        });
        return;
      }
      const body = (await res.json()) as { redirectUrl?: string };
      if (typeof body.redirectUrl !== 'string' || body.redirectUrl.length === 0) {
        setSubmitting(false);
        setError({
          code: 'unexpected_response',
          message: 'Crivacy returned an unexpected response. Try again.',
          status: 0,
        });
        return;
      }
      // Keep `submitting` locked until the redirect actually fires;
      // the page is about to unload so a label flash isn't worth it.
      window.location.assign(body.redirectUrl);
    } catch {
      clearTimeout(stuckTimer);
      setSubmitting(false);
      setError({
        code: 'network_error',
        message: 'Network error. Please try again.',
        status: 0,
      });
    }
  }

  async function submit(decision: 'approve' | 'reject'): Promise<void> {
    if (requestId === null) return;
    setSubmitting(decision);

    // Stuck-button watchdog. If the POST is still in flight after 10
    // seconds we reset the button so the user can retry, prevents the
    // "I clicked Approve and it froze" UX cliff when the backend call
    // is delayed behind a cold start or a flaky webhook dispatch. The
    // timer is cleared in both success and failure paths below.
    const stuckTimer = setTimeout(() => {
      setSubmitting(false);
      setError({
        code: 'slow_response',
        message:
          'Your decision is taking longer than expected. You can try again or reload the page.',
        status: 0,
      });
    }, 10_000);

    try {
      const res = await fetch('/api/v1/oauth/consent', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, decision }),
      });
      clearTimeout(stuckTimer);
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        setError({
          code: body?.error?.code ?? 'unknown',
          message: body?.error?.message ?? 'Failed to record your decision.',
          status: res.status,
        });
        setSubmitting(false);
        return;
      }
      const body = (await res.json()) as { redirectUrl: string };
      // Use a hard navigation so we don't hold the consent page in
      // history when the user bounces to the firm's callback.
      window.location.href = body.redirectUrl;
    } catch {
      clearTimeout(stuckTimer);
      setError({
        code: 'network_error',
        message: 'Network error. Please try again.',
        status: 0,
      });
      setSubmitting(false);
    }
  }

  // `loading` is reserved for future pivots (e.g. a manual refresh
  // action). Server-side bootstrap means we're never loading on
  // first paint. Keep the branch to avoid touching every render
  // permutation if the flag re-activates later.
  if (loading) {
    return null;
  }

  if (error !== null) {
    // Separate the "link is dead" cases from generic failures so the
    // user sees a message that matches what actually went wrong:
    //   - 410: the authorize request TTL (15 min) elapsed
    //   - 409: the authorize request was already completed elsewhere
    //   - 404: never existed (tampered id, dev copy-paste)
    const isExpired = error.status === 410;
    const isCompleted = error.status === 409;
    const title = isExpired
      ? 'This link has expired'
      : isCompleted
        ? 'Already completed'
        : "Couldn't start verification";
    const body = isExpired
      ? 'Authorization links stay valid for 15 minutes. Head back and start a fresh one.'
      : isCompleted
        ? 'This authorization was finalised in another tab. You can close this one.'
        : error.message;
    return (
      <ConsentShell>
        <Card>
          <CardContent className="space-y-6 px-6 py-8 text-sm">
            <div className="flex justify-center">
              {isExpired ? <ClockIcon /> : isCompleted ? <CheckCircleIcon /> : <AlertIcon />}
            </div>
            <div className="space-y-2 text-center">
              <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">
                {title}
              </h1>
              <p className="text-[var(--color-muted)]">{body}</p>
            </div>
            <div className="flex flex-col gap-2">
              <Button asChild className="w-full">
                <a href="/">Return to Crivacy home</a>
              </Button>
            </div>
          </CardContent>
        </Card>
      </ConsentShell>
    );
  }

  if (data === null) return null;

  const { request, client, user, cachedConsent, kycGate } = data;

  // The KYC gate branch, user has no credential, or a credential
  // below the level the requested scopes demand. We refuse to render
  // the approve button in this state because `/userinfo` would later
  // return an empty claim set, which firms can't distinguish from
  // "user said yes but is secretly not verified". Instead we show a
  // dedicated card that sends the user into the KYC flow with a
  // `continue` ticket that lands them back here post-verification.
  if (kycGate.needsKyc || kycGate.needsKycUpgrade) {
    const heading = kycGate.needsKyc
      ? `${client.name} wants to verify your identity`
      : `${client.name} needs a higher level of verification`;
    const subheading = kycGate.needsKyc
      ? `Crivacy verifies you once. Takes about 2 minutes. Future sign-ins to any Crivacy partner reuse the same credential, no document uploads to ${client.name}.`
      : `${client.name} asks for a higher assurance level than your current credential carries. You'll complete only the next tier, not a fresh verification.`;
    // Cross-reference `kycGate.missingScopes` (IDs only) against the
    // full scope list to get human descriptions. Falls back to the
    // raw id when a description is absent.
    const missingScopeDetails = kycGate.missingScopes.map((id) => {
      const enriched = request.scopes.find((s) => s.id === id);
      return {
        id,
        description: enriched?.description ?? null,
      };
    });
    return (
      <ConsentShell>
        <Card>
          <CardHeader>
            <ClientHeader client={client} subtitle={user.email ?? `user ${user.id.slice(0, 8)}…`} />
          </CardHeader>
          <CardContent className="space-y-6 text-sm">
            <section className="space-y-2">
              <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
              <p className="text-[var(--color-muted)]">{subheading}</p>
            </section>

            {missingScopeDetails.length > 0 ? (
              <section>
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--color-muted)]">
                  {client.name} will receive
                </h2>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {missingScopeDetails.map((scope) => (
                    <li key={scope.id}>
                      <ScopeBadge scopeId={scope.id} fallback={scope.description} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div className="flex flex-col gap-2">
              {/* One click from here straight to the Didit hosted
                  flow, no `/kyc` dashboard stop in between. The
                  backend recomputes the KYC gate, rate-limits, and
                  resumes any in-flight Didit session instead of
                  starting a duplicate billable one. */}
              <Button
                className="w-full"
                disabled={submitting !== false}
                onClick={() => {
                  if (submitting !== false) return;
                  void startKyc();
                }}
              >
                {submitting === 'start_kyc' ? 'Starting verification…' : 'Start verification'}
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => void submit('reject')}
                disabled={submitting !== false}
              >
                {submitting === 'reject' ? 'Returning…' : `Cancel and return to ${client.name}`}
              </Button>
            </div>

            <ConsentFooter client={client} />
          </CardContent>
        </Card>
      </ConsentShell>
    );
  }

  return (
    <ConsentShell>
      <Card>
        <CardHeader>
          <ClientHeader client={client} subtitle={user.email ?? `user ${user.id.slice(0, 8)}…`} />
        </CardHeader>
        <CardContent className="space-y-6 text-sm">
          <section className="space-y-2">
            <h1 className="text-xl font-semibold tracking-tight">
              {client.name} wants to see your verified identity
            </h1>
            {client.description !== null ? (
              <p className="text-[var(--color-muted)]">{client.description}</p>
            ) : (
              <p className="text-[var(--color-muted)]">
                Approve to share the claims below. You stay in control. Revoke any time
                from your Crivacy settings.
              </p>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--color-muted)]">
              This will share
            </h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {request.scopes.map((scope) => (
                <li key={scope.id}>
                  <ScopeBadge scopeId={scope.id} fallback={scope.description} />
                </li>
              ))}
            </ul>
          </section>

          {cachedConsent !== null ? (
            <p className="rounded-[var(--radius-sm)] border border-[var(--color-success)]/30 bg-[var(--color-success)]/10 p-3 text-xs text-[var(--color-success)]">
              You previously approved this request on{' '}
              {new Date(cachedConsent.grantedAt).toLocaleDateString()}. Approving
              again extends the window until{' '}
              {new Date(cachedConsent.expiresAt).toLocaleDateString()}.
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => void submit('reject')}
              disabled={submitting !== false}
            >
              {submitting === 'reject' ? 'Declining…' : 'Decline'}
            </Button>
            <Button
              className="flex-1"
              onClick={() => void submit('approve')}
              disabled={submitting !== false}
            >
              {submitting === 'approve' ? 'Approving…' : 'Approve'}
            </Button>
          </div>

          <ConsentFooter client={client} />
        </CardContent>
      </Card>
    </ConsentShell>
  );
}

/* ---------- Shared UI bits ---------- */

interface ClientSummary {
  readonly name: string;
  readonly description: string | null;
  readonly logoUrl: string | null;
  readonly homepageUrl: string | null;
}

/**
 * Mirrors the chrome that `AuthShell` gives `/login`, `/register`
 * etc.: gradient page background, real `CrivacyLogo` wordmark at the
 * top, Terms + Privacy footer at the bottom. Keeps the consent
 * surface visually part of the same product instead of floating on a
 * bare page.
 */
function ConsentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-[var(--color-bg)] via-[var(--color-surface)] to-[var(--color-bg)] px-4 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="inline-block text-[var(--color-fg)] transition-colors hover:text-[var(--color-accent)]"
          >
            <CrivacyLogo className="mx-auto h-9" />
          </Link>
        </div>

        {children}

        <div className="mt-6 flex justify-center gap-1 text-xs text-[var(--color-muted)]">
          <Link href="/terms" className="transition-colors hover:text-[var(--color-accent)]">
            Terms
          </Link>
          <span aria-hidden="true">&middot;</span>
          <Link href="/privacy" className="transition-colors hover:text-[var(--color-accent)]">
            Privacy
          </Link>
        </div>
      </div>
    </div>
  );
}

function ClientHeader({ client, subtitle }: { client: ClientSummary; subtitle: string }) {
  return (
    <div className="flex items-center gap-3">
      {client.logoUrl !== null ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={client.logoUrl}
          alt=""
          aria-hidden="true"
          className="h-11 w-11 shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] object-cover"
        />
      ) : (
        <LogoPlaceholder name={client.name} />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold text-[var(--color-fg)]">
          {client.name}
        </div>
        <div className="truncate text-xs text-[var(--color-muted)]">
          Signed in as {subtitle}
        </div>
      </div>
    </div>
  );
}

/**
 * Fallback logo: the client's first two initials on a gradient chip.
 * Renders deterministically so a firm that forgot to upload a logo
 * still gets a visual anchor instead of a blank header.
 */
function LogoPlaceholder({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    || name.slice(0, 2).toUpperCase();
  return (
    <div
      aria-hidden="true"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-accent)]/30 to-[var(--color-accent)]/5 font-mono text-xs font-bold tracking-wider text-[var(--color-fg)]"
    >
      {initials}
    </div>
  );
}

function CheckIcon() {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)]/15 text-[10px] font-bold text-[var(--color-accent)]"
    >
      ✓
    </span>
  );
}

/**
 * Display metadata for each scope, two-tier structure: a terse
 * label (bold, scannable) + a short data line describing what
 * actually travels (muted, one phrase). Backend `description` prose
 * is intentionally bypassed here because consent screens want
 * scannable key/value, not paragraphs.
 *
 * Fallback: if a new scope ships without a UI label, we show the
 * backend prose instead so nothing silently disappears.
 */
interface ScopeDisplayMeta {
  readonly label: string;
  readonly detail: string;
}

const SCOPE_DISPLAY: Readonly<Record<string, ScopeDisplayMeta>> = {
  openid: {
    label: 'Crivacy user ID',
    detail: 'Stable id for this user across sign-ins',
  },
  kyc: {
    label: 'Identity verification',
    detail: 'Government ID, liveness, face match',
  },
  'kyc:address': {
    label: 'Address verification',
    detail: 'Proof-of-address status',
  },
  'credential': {
    label: 'On-chain credential',
    detail: 'Proof hash, validity, issuing validator',
  },
  'kyc:scores': {
    label: 'Humanity score',
    detail: 'Numerical quality / humanity rating',
  },
};

function ScopeBadge({
  scopeId,
  fallback,
}: {
  scopeId: string;
  fallback?: string | null;
}) {
  const meta = SCOPE_DISPLAY[scopeId];
  const label = meta?.label ?? fallback ?? scopeId;
  const detail = meta?.detail ?? null;
  return (
    <div className="h-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      <p className="text-sm font-medium leading-snug text-[var(--color-fg)]">{label}</p>
      {detail !== null ? (
        <p className="mt-0.5 text-[11px] leading-snug text-[var(--color-muted)]">{detail}</p>
      ) : null}
    </div>
  );
}


/* ---------- Error-page hero icons (48px, centered above title) ---------- */

function ClockIcon() {
  return (
    <span
      aria-hidden="true"
      className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-muted)]/10 text-[var(--color-muted)]"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-6 w-6"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    </span>
  );
}

function AlertIcon() {
  return (
    <span
      aria-hidden="true"
      className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-muted)]/10 text-[var(--color-muted)]"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-6 w-6"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
    </span>
  );
}

function CheckCircleIcon() {
  return (
    <span
      aria-hidden="true"
      className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-6 w-6"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 3 3 5-5" />
      </svg>
    </span>
  );
}

function ConsentFooter({ client }: { client: ClientSummary }) {
  return (
    <footer className="space-y-1.5 border-t border-[var(--color-border)] pt-3 text-[11px] text-[var(--color-muted)]">
      {client.homepageUrl !== null ? (
        <p>
          Requested by{' '}
          <a
            href={client.homepageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-accent)] underline-offset-2 hover:underline"
          >
            {client.homepageUrl.replace(/^https?:\/\//, '')}
          </a>
        </p>
      ) : null}
      <p>
        Crivacy never hands over your documents. Only the verified claims you approve.
        Revoke this app&apos;s access anytime at{' '}
        <a
          href="/settings/connected-apps"
          className="text-[var(--color-accent)] underline-offset-2 hover:underline"
        >
          /settings/connected-apps
        </a>
        .
      </p>
    </footer>
  );
}
