'use client';

import * as React from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { CrivacyLogo } from '@/components/shared/crivacy-logo';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface ConsumeHandoffResponse {
  readonly redirectUrl: string | null;
  readonly sessionId: string;
}

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

type HandoffState =
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly redirectUrl: string | null; readonly sessionId: string }
  | { readonly status: 'error'; readonly message: string };

/**
 * Minimum time the loading state stays visible before a status change.
 * Prevents the success/redirect from flashing past the user when the
 * chain round-trip happens to be fast, gives a perceptible
 * "transferring securely" beat that matches the framing copy.
 */
const MIN_LOADING_MS = 1200;

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Device handoff landing page. When a customer scans the QR code on
 * their phone, they land here. This page consumes the one-shot token
 * via `POST /api/customer/kyc/handoff/[token]` and either redirects to
 * the Didit hosted verification flow on success, or surfaces a clear
 * recovery path on error.
 *
 * The endpoint is POST (not GET) so prefetchers, link-preview bots, and
 * antivirus URL scanners cannot burn a one-shot token before the human
 * actually opens the page, the customer's browser is the only agent
 * that runs `fetch(...)` on mount.
 *
 * Copy intentionally avoids "handoff", most users don't know the
 * term. The page leads with the Crivacy mark + "Securing your
 * verification" so the experience reads like a deliberate handoff
 * step in the same flow rather than a foreign-looking interstitial.
 */
export default function HandoffConsumePage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = typeof params?.['token'] === 'string' ? params['token'] : '';

  // Design-preview override. Visiting `?preview=loading|redirecting|
  // preparing|error` short-circuits the consume + redirect pipeline
  // and freezes the page on the requested panel. Lets us preview /
  // QA the four UI states without burning a real one-shot token or
  // arranging the underlying race conditions. The real flow is
  // unaffected when the param is absent. Token presence is required
  // (matches the route shape) so a bare /kyc/handoff URL is still 404.
  const previewMode = searchParams?.get('preview') ?? null;
  const initialState: HandoffState =
    previewMode === 'loading'
      ? { status: 'loading' }
      : previewMode === 'redirecting'
        ? { status: 'success', redirectUrl: '#preview-redirect-target', sessionId: 'preview-session' }
        : previewMode === 'preparing'
          ? { status: 'success', redirectUrl: null, sessionId: 'preview-session' }
          : previewMode === 'error'
            ? { status: 'error', message: 'This is a preview of the error state. The real flow surfaces the backend message verbatim.' }
            : { status: 'loading' };

  const [state, setState] = React.useState<HandoffState>(initialState);
  const consumedRef = React.useRef(previewMode !== null);

  React.useEffect(() => {
    if (consumedRef.current || token.length === 0) return;
    consumedRef.current = true;

    const start = Date.now();

    async function consumeToken() {
      let nextState: HandoffState;
      try {
        const res = await fetch(`/api/customer/kyc/handoff/${token}`, {
          method: 'POST',
          cache: 'no-store',
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
          nextState = {
            status: 'error',
            message: body.error?.message ?? 'We could not open this link on this device.',
          };
        } else {
          const data = (await res.json()) as ConsumeHandoffResponse;
          nextState = {
            status: 'success',
            redirectUrl: data.redirectUrl,
            sessionId: data.sessionId,
          };
        }
      } catch {
        nextState = {
          status: 'error',
          message: 'Network error. Please check your connection and try again.',
        };
      }

      // Hold the loading state at least MIN_LOADING_MS so the user
      // gets a beat to read the framing copy before the redirect.
      const elapsed = Date.now() - start;
      const wait = Math.max(0, MIN_LOADING_MS - elapsed);
      setTimeout(() => {
        setState(nextState);
        if (nextState.status === 'success' && nextState.redirectUrl !== null) {
          window.location.href = nextState.redirectUrl;
        }
      }, wait);
    }

    void consumeToken();
  }, [token]);

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center px-6">
      {/* Brand mark, single lockup (owl + wordmark). The full
          CrivacyLogo already includes both glyphs; no second iconOnly
          variant needed. */}
      <div className="mb-10 text-[var(--color-fg)]">
        <CrivacyLogo className="h-8" />
      </div>

      {state.status === 'loading' && <LoadingPanel />}

      {state.status === 'success' && state.redirectUrl !== null && (
        <RedirectingPanel redirectUrl={state.redirectUrl} />
      )}

      {state.status === 'success' && state.redirectUrl === null && (
        <PreparingPanel onReturn={() => router.push('/kyc')} />
      )}

      {state.status === 'error' && (
        <ErrorPanel message={state.message} onReturn={() => router.push('/kyc')} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Panels                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Loading state, what the user sees during the consume + redirect
 * round-trip. Single thin ring spinner (Stripe Connect / Vercel /
 * Linear pattern), no flashing badge, no decorative halo. The
 * security framing comes from the inline shield label below the copy,
 * not from the loader glyph.
 */
function LoadingPanel() {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <RingSpinner />
      <div className="space-y-1.5">
        <h1 className="text-[15px] font-semibold tracking-tight text-[var(--color-fg)]">
          Securing your verification
        </h1>
        <p className="text-sm text-[var(--color-muted)]">
          Continuing on this device. This takes just a moment.
        </p>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        Encrypted handoff via Crivacy
      </p>
    </div>
  );
}

/**
 * Success → about to redirect. Same shape as loading so the visual
 * frame stays steady; only the icon and copy change. Auto-redirect
 * has already been queued by the page's effect; the manual link is a
 * fallback for browsers that block top-level navigation triggered
 * from script (rare, but cheap to provide).
 */
function RedirectingPanel({ redirectUrl }: { readonly redirectUrl: string }) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <CheckCircle2
        className="h-12 w-12 text-[var(--color-success)]"
        aria-hidden="true"
      />
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">
          Opening your verification
        </h1>
        <p className="text-sm text-[var(--color-muted)]">
          Taking you to the secure verification flow now.
        </p>
      </div>
      <a
        href={redirectUrl}
        className="text-xs text-[var(--color-accent)] underline-offset-2 hover:underline"
      >
        Not redirected? Tap here to continue.
      </a>
    </div>
  );
}

/**
 * Edge case: handoff verified but the bound session has no live
 * Didit URL (very rare, pre-`verification_url` historical row, or
 * the Didit URL got nulled out by a stale-host migration). The
 * customer goes back to the verification page on their original
 * device.
 */
function PreparingPanel({ onReturn }: { readonly onReturn: () => void }) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <CheckCircle2
        className="h-12 w-12 text-[var(--color-success)]"
        aria-hidden="true"
      />
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">
          Almost ready
        </h1>
        <p className="text-sm text-[var(--color-muted)]">
          Your verification session is being prepared. Please return to your
          original device to continue.
        </p>
      </div>
      <Button variant="outline" onClick={onReturn}>
        Go to verification
      </Button>
    </div>
  );
}

/**
 * Error state, token expired, already used, or session not found.
 * Surfaces the backend's user-facing message verbatim (already
 * sanitised + i18n-friendly server-side) and offers a return path
 * rather than leaving the user on a dead end.
 */
function ErrorPanel({
  message,
  onReturn,
}: {
  readonly message: string;
  readonly onReturn: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <XCircle
        className="h-12 w-12 text-[var(--color-danger)]"
        aria-hidden="true"
      />
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">
          We could not open this link
        </h1>
        <p className="text-sm text-[var(--color-muted)]">{message}</p>
      </div>
      <Button variant="outline" onClick={onReturn}>
        Return to verification
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Ring spinner, Stripe / Vercel / Linear-grade thin indeterminate ring     */
/* -------------------------------------------------------------------------- */

/**
 * Thin monochrome ring with a single rotating arc. The faint full
 * circle behind the arc keeps the loader legible against any
 * background; the arc is the only animated element. This is the
 * canonical "secure operation in progress" affordance used by
 * Stripe Connect, Vercel deploys, Linear app, no decorative halo,
 * no badge stack, no emoji-feeling.
 *
 * `prefers-reduced-motion: reduce` slows the spin by ~3× rather than
 * killing it outright; the spin is still informative ("we're working,
 * not frozen") even at reduced motion.
 */
function RingSpinner() {
  return (
    <svg
      className="h-9 w-9 animate-spin text-[var(--color-accent)]"
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="Loading"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeOpacity="0.18"
        strokeWidth="1.75"
      />
      <path
        d="M22 12 a10 10 0 0 1 -7 9.54"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
