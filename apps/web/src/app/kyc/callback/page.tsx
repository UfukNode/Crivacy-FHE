'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Clock, HelpCircle, Loader2, Smartphone } from 'lucide-react';

import { CrivacyLogo } from '@/components/shared/crivacy-logo';
import { Button } from '@/components/ui/button';
import type { CallbackVariant } from '@/lib/kyc/phase-registry';

/**
 * Post-verification landing page, Didit redirects the user's browser
 * here after they finish the hosted KYC flow.
 *
 * Sprint 9 rewrite: this page polls the backend for the REAL
 * `kyc_sessions` row state instead of trusting the
 * `?status=Approved` query parameter the previous version rendered
 * directly. The pre-Sprint-9 behaviour was a UX bug, the page
 * cheerfully said "Verification complete" off a URL the customer
 * could craft by hand, while the backend session might still be
 * `pending` (webhook 401 is enough to leave it stuck).
 *
 * Flow
 * ----
 *   1. Read `?verificationSessionId=<diditSessionId>` from the URL
 *      (the canonical Didit-supplied parameter; `?status=` is no
 *      longer consulted).
 *   2. Poll `GET /api/customer/kyc/callback-status?session=<id>`
 *      every {@link POLL_INTERVAL_MS} ms.
 *   3. The endpoint validates ownership (cookie auth) AND
 *      opportunistically pulls Didit when the row is non-terminal,
 *      so this page acts as both UI and pull-fallback driver.
 *   4. Once the endpoint returns `isTerminal: true`, render the
 *      registry-resolved variant. Until then, show a "Verifying…"
 *      spinner.
 *   5. After {@link MAX_POLL_DURATION_MS} the page falls into a
 *      neutral "still processing, return to dashboard" state so
 *      the user is never stranded if Didit + reconciler somehow
 *      both fail to converge.
 *
 * Trust boundary
 * --------------
 *   * The URL `verificationSessionId` is treated as opaque user
 *     input, we hand it to the backend, the backend looks it up
 *     scoped to the calling customer (cookie auth), and a
 *     cross-account probe returns 404. The page never echoes the
 *     id into the DOM.
 *   * `?status=` from Didit is intentionally IGNORED. Any future
 *     change Didit makes to that parameter cannot affect what the
 *     page displays.
 *   * Anonymous landings (phone handoff with no cookie) get a 401
 *     and the page falls into the neutral "submitted" branch,
 *     same UX the pre-Sprint-9 page presented for unknown
 *     statuses, but now matched to the actual auth state instead
 *     of guessed from the URL.
 */

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_DURATION_MS = 30_000;

/* ------------------------------------------------------------------ */
/*  Variant copy                                                      */
/* ------------------------------------------------------------------ */

interface VariantCopy {
  readonly icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  readonly iconColor: string;
  readonly title: string;
  readonly body: string;
  readonly returnHref: '/kyc' | '/';
  readonly returnLabel: string;
}

const VARIANT_COPY: Readonly<Record<CallbackVariant, VariantCopy>> = {
  approved: {
    icon: CheckCircle2,
    iconColor: 'text-[var(--color-success)]',
    title: 'Verification complete',
    body: 'You can close this tab and return to your computer to continue. The next step will appear there automatically.',
    returnHref: '/kyc',
    returnLabel: 'Return to dashboard',
  },
  in_review: {
    icon: Clock,
    iconColor: 'text-[var(--color-warning)]',
    title: 'Verification under review',
    body: 'Your verification was submitted and is being reviewed. You can close this tab; the result will appear on your dashboard once review is complete.',
    returnHref: '/kyc',
    returnLabel: 'Return to dashboard',
  },
  declined: {
    icon: AlertTriangle,
    iconColor: 'text-[var(--color-danger)]',
    title: 'Verification could not be completed',
    body: 'We could not verify your identity in this session. Return to your dashboard to see the reason and try again.',
    returnHref: '/kyc',
    returnLabel: 'Return to verification',
  },
  in_progress: {
    icon: Clock,
    iconColor: 'text-[var(--color-muted)]',
    title: 'Verification in progress',
    body: 'Your verification is still being processed. Return to your dashboard, the next step will appear there automatically when it is ready.',
    returnHref: '/kyc',
    returnLabel: 'Return to dashboard',
  },
  // The `unknown` branch lights up when the customer lands on
  // `/kyc/callback` without a usable session cookie, the most common
  // cause being the phone-handoff path (the QR-scanned mobile device
  // is signed in to Didit but not to Crivacy). Pre-Sprint-10 the icon
  // was `HelpCircle` (a question mark), which read as "we don't know
  // what happened", confusing for a user who just successfully
  // submitted a verification. The Smartphone icon + "submitted" copy
  // matches the actual situation: their action succeeded, the result
  // will appear on the desktop they originally started on.
  unknown: {
    icon: Smartphone,
    iconColor: 'text-[var(--color-success)]',
    title: 'Verification submitted',
    body: 'Thanks, your verification is submitted. You can close this tab and return to your computer; the result will appear on your dashboard automatically.',
    returnHref: '/kyc',
    returnLabel: 'Return to dashboard',
  },
};

/* ------------------------------------------------------------------ */
/*  API contract                                                      */
/* ------------------------------------------------------------------ */

interface CallbackStatusResponse {
  readonly phase: 'identity' | 'address' | 'nft_mint';
  readonly sessionStatus: string;
  readonly variant: CallbackVariant;
  readonly continueUrl: string | null;
  readonly isTerminal: boolean;
}

type PollState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'resolved';
      readonly variant: CallbackVariant;
      readonly continueUrl: string | null;
    }
  | { readonly kind: 'timeout' };

/**
 * One callback-status fetch. Resolves to one of:
 *   * the parsed terminal/non-terminal status (server hit, 200),
 *   * `'unauth'` when the customer cookie is missing (phone handoff
 *     with no session, page falls into neutral branch),
 *   * `'not-found'` when the server can't locate the session,
 *     same neutral branch (the URL was bogus or expired),
 *   * `'transient'` for network / 5xx / parse failures so the poll
 *     keeps trying without changing UI state.
 */
const KNOWN_VARIANTS: readonly CallbackVariant[] = [
  'approved',
  'in_review',
  'declined',
  'in_progress',
  'unknown',
];

function narrowVariant(value: unknown): CallbackVariant {
  if (typeof value !== 'string') return 'unknown';
  return (KNOWN_VARIANTS as readonly string[]).includes(value)
    ? (value as CallbackVariant)
    : 'unknown';
}

async function fetchCallbackStatus(
  sessionId: string,
  signal: AbortSignal,
): Promise<CallbackStatusResponse | 'not-found' | 'transient'> {
  // Primary path, auth-gated endpoint. Returns the rich response
  // (phase, sessionStatus, continueUrl) which the desktop page
  // needs for OAuth resume.
  let res: Response;
  try {
    res = await fetch(
      `/api/customer/kyc/callback-status?session=${encodeURIComponent(sessionId)}`,
      {
        method: 'GET',
        credentials: 'include',
        signal,
        cache: 'no-store',
      },
    );
  } catch {
    return 'transient';
  }

  if (res.status === 401 || res.status === 403) {
    // Phone-handoff fallback: this device has no customer cookie
    // (QR-scanned mobile signed in only to Didit, not Crivacy). Use
    // the public endpoint that returns just the variant, enough
    // for the page to surface a faithful outcome ("declined" /
    // "approved" / "in_review") instead of the misleading neutral
    // "submitted" branch the pre-fix flow rendered for everything.
    return await fetchPublicCallbackStatus(sessionId, signal);
  }
  if (res.status === 404) return 'not-found';
  if (!res.ok) return 'transient';

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return 'transient';
  }
  if (data === null || typeof data !== 'object') return 'transient';

  const obj = data as Record<string, unknown>;
  const variant = obj['variant'];
  const isTerminal = obj['isTerminal'];
  const phase = obj['phase'];
  const sessionStatus = obj['sessionStatus'];
  const continueUrl = obj['continueUrl'];

  if (
    typeof variant !== 'string' ||
    typeof isTerminal !== 'boolean' ||
    typeof phase !== 'string' ||
    typeof sessionStatus !== 'string' ||
    !(continueUrl === null || typeof continueUrl === 'string')
  ) {
    return 'transient';
  }

  return {
    phase: phase as 'identity' | 'address' | 'nft_mint',
    sessionStatus,
    variant: narrowVariant(variant),
    continueUrl,
    isTerminal,
  };
}

/**
 * Phone-handoff fallback. Hits the public bearer-only endpoint that
 * accepts the Didit `verificationSessionId` directly (treated as a
 * bearer token, the id is unguessable UUID-grade). Returns the same
 * shape as the auth'd path so the polling loop is unchanged, with
 * `phase` / `sessionStatus` / `continueUrl` filled with safe defaults
 * (the mobile device never needs to drive an OAuth resume).
 */
async function fetchPublicCallbackStatus(
  sessionId: string,
  signal: AbortSignal,
): Promise<CallbackStatusResponse | 'not-found' | 'transient'> {
  let res: Response;
  try {
    res = await fetch(
      `/api/public/kyc/callback-status?session=${encodeURIComponent(sessionId)}`,
      {
        method: 'GET',
        signal,
        cache: 'no-store',
      },
    );
  } catch {
    return 'transient';
  }
  if (res.status === 404) return 'not-found';
  if (!res.ok) return 'transient';

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return 'transient';
  }
  if (data === null || typeof data !== 'object') return 'transient';
  const obj = data as Record<string, unknown>;
  const variant = obj['variant'];
  const isTerminal = obj['isTerminal'];
  if (typeof variant !== 'string' || typeof isTerminal !== 'boolean') {
    return 'transient';
  }
  return {
    phase: 'identity',
    sessionStatus: '',
    variant: narrowVariant(variant),
    continueUrl: null,
    isTerminal,
  };
}

/* ------------------------------------------------------------------ */
/*  Same-origin redirect guard                                        */
/* ------------------------------------------------------------------ */

/**
 * Defence-in-depth: re-validate `continueUrl` on the client before
 * navigating. The backend already enforces same-origin at write +
 * read; this is the third gate so a future regression cannot turn
 * the callback page into an open-redirect surface.
 */
function safeContinueUrl(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw.length === 0) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  return raw;
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

export default function KycCallbackPage() {
  const searchParams = useSearchParams();
  const sessionId = searchParams?.get('verificationSessionId') ?? null;

  const [state, setState] = React.useState<PollState>(
    sessionId === null
      ? // No session id in URL, nothing to poll. Show neutral
        // "submitted" branch right away.
        { kind: 'resolved', variant: 'unknown', continueUrl: null }
      : { kind: 'loading' },
  );

  React.useEffect(() => {
    if (sessionId === null) return undefined;
    if (state.kind !== 'loading') return undefined;

    const ctrl = new AbortController();
    const startedAt = Date.now();
    let cancelled = false;

    async function tick(): Promise<void> {
      if (cancelled) return;
      // sessionId is non-null on this code path (guarded above).
      const result = await fetchCallbackStatus(sessionId as string, ctrl.signal);
      if (cancelled) return;

      if (result === 'not-found') {
        setState({ kind: 'resolved', variant: 'unknown', continueUrl: null });
        return;
      }

      if (result === 'transient') {
        // Network or 5xx, keep polling until the deadline.
        if (Date.now() - startedAt >= MAX_POLL_DURATION_MS) {
          setState({ kind: 'timeout' });
          return;
        }
        scheduleNext();
        return;
      }

      if (result.isTerminal) {
        const variant = result.variant;
        const continueUrl = safeContinueUrl(result.continueUrl);
        setState({ kind: 'resolved', variant, continueUrl });

        // Auto-redirect on Approved + continue URL, the OAuth
        // resume path lands the user back at /oauth/consent
        // (or wherever the start handler persisted).
        if (variant === 'approved' && continueUrl !== null) {
          // Tiny dwell so the user briefly sees the success state
          // before the redirect, matches the handoff page UX.
          window.setTimeout(() => {
            if (!cancelled) {
              window.location.href = continueUrl;
            }
          }, 800);
        }
        return;
      }

      // Non-terminal (in_progress / unknown). Keep polling until
      // either the row transitions or the deadline elapses.
      if (Date.now() - startedAt >= MAX_POLL_DURATION_MS) {
        setState({ kind: 'timeout' });
        return;
      }
      scheduleNext();
    }

    let timeoutId: number | null = null;
    function scheduleNext(): void {
      timeoutId = window.setTimeout(() => {
        void tick();
      }, POLL_INTERVAL_MS);
    }

    void tick();

    return () => {
      cancelled = true;
      ctrl.abort();
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [sessionId, state.kind]);

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center px-6">
      {/* Crivacy lockup, same single-glyph treatment as the handoff
          landing page so the journey reads as one continuous flow. */}
      <div className="mb-10 text-[var(--color-fg)]">
        <CrivacyLogo className="h-8" />
      </div>

      {state.kind === 'loading' && <LoadingFrame />}
      {state.kind === 'timeout' && <TimeoutFrame />}
      {state.kind === 'resolved' && <ResolvedFrame variant={state.variant} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                    */
/* ------------------------------------------------------------------ */

function LoadingFrame() {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <Loader2
        className="h-10 w-10 animate-spin text-[var(--color-muted)]"
        aria-hidden
      />
      <div className="space-y-1.5">
        <h1 className="text-[15px] font-semibold tracking-tight text-[var(--color-fg)]">
          Finalising your verification…
        </h1>
        <p className="text-sm text-[var(--color-muted)]">
          Confirming the result with our verification provider. This usually takes a few seconds.
        </p>
      </div>
    </div>
  );
}

function TimeoutFrame() {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <HelpCircle className="h-12 w-12 text-[var(--color-muted)]" aria-hidden />
      <div className="space-y-1.5">
        <h1 className="text-[15px] font-semibold tracking-tight text-[var(--color-fg)]">
          Still processing
        </h1>
        <p className="text-sm text-[var(--color-muted)]">
          Your verification is taking a little longer than usual. The result will appear on your
          dashboard once it lands, return there now.
        </p>
      </div>
      <div className="flex flex-col items-center gap-2.5">
        <Button asChild size="sm">
          <Link href="/kyc">Return to dashboard</Link>
        </Button>
        <CloseTabButton />
      </div>
    </div>
  );
}

function ResolvedFrame({ variant }: { readonly variant: CallbackVariant }) {
  const copy = VARIANT_COPY[variant];
  const Icon = copy.icon;
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <Icon className={`h-12 w-12 ${copy.iconColor}`} aria-hidden />
      <div className="space-y-1.5">
        <h1 className="text-[15px] font-semibold tracking-tight text-[var(--color-fg)]">
          {copy.title}
        </h1>
        <p className="text-sm text-[var(--color-muted)]">{copy.body}</p>
      </div>
      <div className="flex flex-col items-center gap-2.5">
        <Button asChild size="sm">
          <Link href={copy.returnHref}>{copy.returnLabel}</Link>
        </Button>
        <CloseTabButton />
      </div>
    </div>
  );
}

/**
 * `window.close()` is silently ignored by browsers when the tab was
 * not opened via `window.open` from script. There is no reliable way
 * to detect that ahead of time, so the button optimistically attempts
 * `window.close()` and surfaces a brief inline hint when the tab
 * stayed open after the call. The hint is a static string so it
 * cannot reflect any user input.
 */
function CloseTabButton() {
  const [showHint, setShowHint] = React.useState(false);

  const handleClose = React.useCallback(() => {
    try {
      window.close();
    } catch {
      // Some browsers throw on cross-origin or non-script-opened
      // windows; treat the same as the silently-ignored case.
    }
    setShowHint(false);
    setTimeout(() => {
      if (typeof window !== 'undefined' && !window.closed) {
        setShowHint(true);
      }
    }, 150);
  }, []);

  return (
    <div className="flex flex-col items-center gap-2">
      <Button variant="ghost" size="sm" onClick={handleClose}>
        Close this tab
      </Button>
      {showHint && (
        <p className="text-xs text-[var(--color-muted)]">
          Your browser blocked the auto-close, please close this tab manually.
        </p>
      )}
    </div>
  );
}
