'use client';

import * as React from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useCameraCheck } from '@/hooks/use-camera-check';
import type { PhaseDefinition } from '@/lib/kyc/phase-registry';

/**
 * Generic, registry-driven action panel for any Didit-driven KYC
 * phase. Replaces the Sprint 7 era `IdentityActionPanel` (renamed
 * Sprint 10) so identity + address render through the same surface.
 *
 * The panel reads three things off the phase registry:
 *
 *   * `phase.startEndpoint`, POST URL the primary button calls when
 *     no active session exists. The backend handler is responsible
 *     for `eligibleStartLevels` enforcement, so we don't re-check
 *     here.
 *   * `phase.supportsHandoff`, gates the QR sub-section. When
 *     `false` (only mint today, but defended for future phases)
 *     the camera-unavailable branch falls through to the primary
 *     button click instead of opening a QR.
 *   * `phase.stepLabel`, drives the primary button copy
 *     ("Start Identity Verification" / "Start Address Verification")
 *     so the panel stays phase-name-agnostic.
 *
 * The handoff backend (`POST /api/customer/kyc/handoff`) is already
 * phase-agnostic: it scopes to the customer's active `kyc_sessions`
 * row regardless of `workflow`, so the same QR generator serves both
 * phases. This panel calls `phase.startEndpoint` first to make sure
 * a session row exists (idempotent, start endpoints resume an
 * existing pending session) before generating the handoff token.
 */
export interface KycActionPanelProps {
  /**
   * Phase registry entry. Drives label, start endpoint, and handoff
   * support. Caller picks `IDENTITY_PHASE` or `ADDRESS_PHASE` from
   * `@/lib/kyc/phase-registry`. The panel does not look up the phase
   * itself, passing the entry through keeps the component pure and
   * tree-shakable.
   */
  readonly phase: PhaseDefinition;
  /**
   * `start`, no active session yet; primary button calls
   * `onStartDesktop` (which navigates to Didit on success).
   * `continue`, there's an in-progress / pending session; primary
   * button navigates to `continueUrl` directly.
   */
  readonly mode: 'start' | 'continue';
  /** Disables the primary button while the parent's start request is in flight. */
  readonly starting: boolean;
  /**
   * Existing session's Didit hosted URL (for `continue` mode).
   * Required when `mode === 'continue'`, ignored otherwise.
   */
  readonly continueUrl?: string | null;
  /**
   * Calls the parent's start handler (which posts to the phase's
   * start endpoint and navigates the desktop tab to the returned
   * Didit URL). Used in `start` mode when the camera is available.
   * The component does not invoke this when the camera is
   * unavailable, instead it switches to the handoff sub-section
   * which calls the start endpoint itself (without navigating).
   */
  readonly onStartDesktop?: () => Promise<void>;
  /**
   * The customer's mobile device has consumed a handoff token for
   * this phase's session, they are now in the Didit flow on their
   * phone. Replaces the QR sub-section with a "verification opened
   * on your phone, continue there" panel and offers a desktop-
   * fallback link that re-opens the same Didit URL on this device.
   * Driven by the `kyc.handoff_consumed` SSE event in the parent
   * /kyc page.
   */
  readonly phoneActive: boolean;
  /**
   * Same-origin path the OAuth fast path persists in
   * `kyc_sessions.metadata.continueUrl` so `/kyc/callback` can land
   * the user back on the partner's authorize flow after Didit
   * approves. Threaded through here so the QR handoff path opens a
   * session row carrying the same continueUrl the desktop start path
   * already does. `null` when the user reached /kyc directly (no
   * partner site bouncing them).
   */
  readonly continuePath?: string | null;
  /**
   * Most recent rejected session for this phase, when it's the
   * customer's *current* state (no later non-rejected session has
   * superseded it). Null in every other case. When non-null the
   * panel renders a "Verification declined" pane above the start
   * button, surfaces `failureReason` so the customer knows why the
   * attempt failed, and relabels the button to "Try again" for
   * affordance. The action is the same start endpoint, Didit
   * doesn't have a "resume rejected session" concept; a retry is a
   * fresh session.
   */
  readonly recentDecline?: {
    readonly failureReason: string | null;
    readonly attempts: number;
  } | null;
  /**
   * Backend cooldown state. When `cooldown.locked === true` the
   * start endpoint will 429; the panel disables the primary button
   * and shows a "Too many attempts" cooldown card with a live
   * countdown until the cooldown ends. UI mirrors the
   * `evaluateDeclineLock` decision the server uses, so a click
   * never gets a surprise 429 while the panel says enabled.
   */
  readonly cooldown?: {
    readonly locked: boolean;
    readonly count: number;
    readonly threshold: number;
    /** ISO timestamp the cooldown ends; null when not locked. */
    readonly cooldownEndsAt: string | null;
  } | null;
}

type HandoffMode = 'closed' | 'auto' | 'manual';

export function KycActionPanel({
  phase,
  mode,
  starting,
  continueUrl,
  onStartDesktop,
  phoneActive,
  continuePath,
  recentDecline,
  cooldown,
}: KycActionPanelProps) {
  // Camera check applies to both phases. Identity needs a camera
  // for ID-document scan + liveness selfie; if it's denied / absent
  // we auto-switch to QR. Address doesn't strictly need a camera
  // (utility-bill upload works without one) but the user expectation
  // is parity: clicking "Start Address Verification" on a no-camera
  // device should land in the same QR sub-section identity does. The
  // auto-mode HEADER text still adapts via `requiresCamera` so the
  // address QR card doesn't say "Camera not available", it shows
  // the neutral "Continue on your phone" prompt.
  const requiresCamera = phase.id === 'identity';
  const { isDenied, isUnsupported } = useCameraCheck();
  const cameraUnavailable = isDenied || isUnsupported;
  const [handoffMode, setHandoffMode] = React.useState<HandoffMode>('closed');

  // Cooldown countdown, derived live from `cooldown.cooldownEndsAt`
  // so the panel stays in sync as time passes without a network
  // round-trip. `null` when not locked / past expiry.
  const cooldownEndsAt = React.useMemo(() => {
    if (cooldown === null || cooldown === undefined) return null;
    if (!cooldown.locked) return null;
    if (cooldown.cooldownEndsAt === null) return null;
    const parsed = new Date(cooldown.cooldownEndsAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }, [cooldown]);
  const cooldownCountdown = useCountdown(cooldownEndsAt);
  const cooldownLocked = cooldown?.locked === true && cooldownEndsAt !== null;

  const isRetry = mode === 'start' && recentDecline !== null && recentDecline !== undefined;
  const primaryLabel =
    mode === 'continue'
      ? `Continue ${phase.stepLabel}`
      : isRetry
        ? `Try ${phase.stepLabel} again`
        : `Start ${phase.stepLabel}`;

  const handlePrimaryClick = React.useCallback(async () => {
    // Two reasons to skip the desktop redirect and open the QR sub-
    // section inline:
    //   1. `phase.defaultsToHandoff`, the phase prefers mobile as
    //      its primary device (e.g. address utility-bill photo).
    //   2. `cameraUnavailable`, the device cannot do this phase's
    //      biometric capture (identity selfie / liveness). The user
    //      would otherwise hit a Didit-side dead end.
    // Either is sufficient. Both branches require `supportsHandoff`
    // (mint phase has no Didit flow at all and is excluded).
    if (phase.supportsHandoff && (phase.defaultsToHandoff || cameraUnavailable)) {
      setHandoffMode('auto');
      return;
    }
    if (mode === 'continue') {
      if (continueUrl !== null && continueUrl !== undefined) {
        window.location.href = continueUrl;
      }
      return;
    }
    if (onStartDesktop !== undefined) {
      await onStartDesktop();
    }
  }, [
    cameraUnavailable,
    phase.supportsHandoff,
    phase.defaultsToHandoff,
    mode,
    continueUrl,
    onStartDesktop,
  ]);

  // Auto-open the handoff section when the phone-active signal
  // arrives while the section is closed (the customer used a
  // QR-link from email or a previous run, so the handoff sub-section
  // never opened on this tab). Without this, the SSE event would
  // arrive but the desktop UI would still show only the primary
  // Start button. The auto-open lands directly in the phone-active
  // state since `phoneActive` is true.
  React.useEffect(() => {
    if (phoneActive && handoffMode === 'closed') {
      setHandoffMode('auto');
    }
  }, [phoneActive, handoffMode]);

  // Stale-handoffMode-after-decline reset.
  //
  // Earlier the parent forced an unmount via `key={mode}` to clear
  // `handoffMode` when a rejected session flipped the panel back to
  // `start`. That had a worse side-effect: while the QR sub-section
  // was open AND `generateHandoff` had just created a fresh session
  // row, the resulting `mode='start' -> 'continue'` flip remounted
  // the panel and **erased the QR mid-display**, before the customer
  // had a chance to scan it.
  //
  // The right protection is direction-aware: only `continue -> start`
  // is dangerous (post-decline / post-expiry the phase's previous
  // handoff card must not silently retry by re-running
  // `generateHandoff` against a stale token). `start -> continue`
  // happens during *every* fresh QR creation and must NOT remount.
  //
  // A useEffect-based reset is fine here because `HandoffSubsection`
  // does NOT remount on mode-prop change, it only mounts once
  // `handoffMode !== 'closed'` first becomes true and unmounts cleanly
  // when this effect flips `handoffMode` back to `'closed'`. No race.
  const previousModeRef = React.useRef<'start' | 'continue'>(mode);
  React.useEffect(() => {
    if (previousModeRef.current === 'continue' && mode === 'start') {
      setHandoffMode('closed');
    }
    previousModeRef.current = mode;
  }, [mode]);

  return (
    <div className="space-y-3">
      {/* Verification-declined pane (Plan A). Renders only when the
          page has surfaced a `recentDecline` signal: this customer
          has a most-recent rejected session for this phase AND no
          newer session is in flight. Surfaces the failure reason
          so the customer is not left guessing. The Start button
          below relabels itself to "Try again" via `isRetry` so the
          affordance lines up with the user's intent. */}
      {recentDecline !== null && recentDecline !== undefined && handoffMode === 'closed' && (
        <div className="space-y-1.5 rounded-[var(--radius-md)] border border-rose-500/40 bg-rose-500/10 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]"
              aria-hidden="true"
            />
            <div className="space-y-0.5">
              {/* Generic decline copy by design. The specific Didit
                  warning text (e.g. DUPLICATED_FACE, INVALID_DOCUMENT)
                  is a fraud-evasion oracle, surfacing it would let an
                  attacker iterate ("face flagged → try a new one",
                  "document flagged → adjust the photo"). Detailed
                  reasons live only in admin / SOC dashboards via
                  audit log + `kyc_sessions.failure_reason`. The
                  legitimate "rebind" case (same Crivacy customer
                  matched against itself) is admin-mediated; this UI
                  intentionally has no rebind affordance. */}
              <p className="text-sm font-medium text-[var(--color-fg)]">
                Verification declined
              </p>
              <p className="text-xs text-[var(--color-muted)]">
                You can try again or contact support if the issue persists.
              </p>
              {/* Attempts-remaining hint. Threshold + count come from
                  the server's `evaluateDeclineLock` snapshot, the UI
                  doesn't hardcode "3 strikes". When locked, the
                  cooldown card below takes over and this line hides.
                  This is a retry-policy signal, not a decline-reason
                  leak, it tells the user how the gate will behave,
                  not what failed. */}
              {cooldown !== null && cooldown !== undefined && !cooldown.locked && (
                <p className="text-xs text-[var(--color-muted)]">
                  {(() => {
                    const remaining = Math.max(0, cooldown.threshold - cooldown.count);
                    if (remaining <= 0) {
                      return 'Next decline will trigger a temporary lock.';
                    }
                    if (remaining === 1) {
                      return '1 attempt left before a temporary lock.';
                    }
                    return `${remaining} attempts left before a temporary lock.`;
                  })()}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Cooldown lock card. When the per-customer decline cap has
          tripped, surface the countdown + disable start. Renders
          above the (disabled) primary button so the customer sees
          the reason before the dead button. Independent of the
          declined pane above, both can render at once when the
          last decline pushed the counter past threshold. */}
      {cooldownLocked && handoffMode === 'closed' && (
        <div className="space-y-1.5 rounded-[var(--radius-md)] border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]"
              aria-hidden="true"
            />
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-[var(--color-fg)]">
                Too many failed attempts
              </p>
              <p className="text-xs text-[var(--color-muted)]">
                Please wait{' '}
                <span className="font-mono font-medium text-[var(--color-fg)]">
                  {cooldownCountdown}
                </span>{' '}
                before trying again.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Primary button. Hidden when we've auto-switched to the
          handoff path (camera unavailable + user clicked Start) so
          the user is not invited to retry the same dead end. Stays
          visible when handoff was opened manually, the user might
          still want to fall back to desktop. Disabled while a
          cooldown lock is active. */}
      {handoffMode !== 'auto' && (
        <Button
          onClick={() => { void handlePrimaryClick(); }}
          disabled={starting || cooldownLocked}
        >
          {starting ? 'Starting…' : primaryLabel}
        </Button>
      )}

      {/* Always-visible secondary affordance for manual phone handoff,
          rendered only for phases that actually support it (registry-
          driven). Hidden once the handoff sub-section is already open. */}
      {phase.supportsHandoff && handoffMode === 'closed' && (
        <button
          type="button"
          onClick={() => setHandoffMode('manual')}
          className="block text-xs text-[var(--color-muted)] underline-offset-2 hover:text-[var(--color-fg)] hover:underline"
        >
          Use a different device
        </button>
      )}

      {handoffMode !== 'closed' && phoneActive && (
        <PhoneActivePanel
          continueUrl={mode === 'continue' ? (continueUrl ?? null) : null}
          onClose={() => setHandoffMode('closed')}
        />
      )}

      {handoffMode !== 'closed' && !phoneActive && (
        <HandoffSubsection
          startEndpoint={phase.startEndpoint}
          autoMode={handoffMode === 'auto'}
          requiresCamera={requiresCamera}
          continuePath={continuePath ?? null}
          onClose={() => setHandoffMode('closed')}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Phone-active panel, sector-standard "verification opened on your phone"  */
/* -------------------------------------------------------------------------- */

/**
 * Replaces the QR card after the customer scans on their phone (the
 * `kyc.handoff_consumed` SSE event flips `phoneActive`). Mirrors the
 * Stripe Identity / Persona / Onfido handoff UX: the desktop ack-
 * nowledges that the verification has moved to the phone, communi-
 * cates that the page will update automatically when the phone-side
 * flow completes, and offers an opt-out for users who realise they
 * want to finish on this device after all.
 *
 * The opt-out (`continueUrl !== null`) just navigates the desktop
 * tab to the same Didit hosted URL the phone is already in, Didit
 * tolerates the same session URL being open on multiple devices, so
 * this is not destructive. There is intentionally no "cancel session"
 * button because (a) cancellation would also abort the phone-side
 * flow the customer is mid-way through, and (b) we have no
 * customer-side cancel endpoint to wire to anyway.
 */
function PhoneActivePanel({
  continueUrl,
  onClose,
}: {
  readonly continueUrl: string | null;
  readonly onClose: () => void;
}) {
  return (
    <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border)]/60 bg-[var(--color-surface)]/50 p-4">
      <div className="flex flex-col items-center gap-4 py-2 text-center">
        {/* Thin ring spinner, same Stripe/Vercel/Linear pattern used
            on the handoff landing page so the visual language is
            consistent across the cross-device flow. */}
        <svg
          className="h-9 w-9 animate-spin text-[var(--color-accent)]"
          viewBox="0 0 24 24"
          fill="none"
          role="status"
          aria-label="Waiting for phone verification"
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
        <div className="space-y-1">
          <p className="text-sm font-medium text-[var(--color-fg)]">
            Verification opened on your phone
          </p>
          <p className="text-xs text-[var(--color-muted)]">
            Continue there. This page will update automatically when
            you finish.
          </p>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Encrypted handoff via Crivacy
        </p>
      </div>
      {continueUrl !== null && (
        <div className="text-center">
          <button
            type="button"
            onClick={() => {
              window.location.href = continueUrl;
            }}
            className="text-xs text-[var(--color-muted)] underline-offset-2 hover:text-[var(--color-fg)] hover:underline"
          >
            Continue on this device instead
          </button>
        </div>
      )}
      <div className="text-center">
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-[var(--color-muted)] underline-offset-2 hover:text-[var(--color-fg)] hover:underline"
        >
          Hide
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Handoff sub-section, internal                                            */
/* -------------------------------------------------------------------------- */

type HandoffState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly qrDataUrl: string;
      readonly handoffUrl: string;
      readonly expiresAt: Date;
    }
  | { readonly status: 'expired' }
  // Backend signalled that Didit already approved this phase but the
  // chain mint pipeline has not yet finalized the credential. The
  // user shouldn't open Didit again (no QR to scan, no work for them
  // to do); the SSE listener on the parent /kyc page will refresh
  // the step state once mint completes. Surface as an info-toned
  // wait message, distinct from `error` so the styling stays calm.
  | { readonly status: 'mint_pending' }
  | { readonly status: 'error'; readonly message: string };

interface HandoffResponse {
  readonly token: string;
  readonly qrDataUrl: string;
  readonly handoffUrl: string;
  readonly expiresAt: string;
}

function useCountdown(target: Date | null): string {
  const [text, setText] = React.useState('');

  React.useEffect(() => {
    if (target === null) {
      setText('');
      return;
    }
    function tick() {
      const diff = target!.getTime() - Date.now();
      if (diff <= 0) {
        setText('0:00');
        return;
      }
      const mins = Math.floor(diff / 60_000);
      const secs = Math.floor((diff % 60_000) / 1000);
      setText(`${mins}:${secs.toString().padStart(2, '0')}`);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);

  return text;
}

function HandoffSubsection({
  startEndpoint,
  autoMode,
  requiresCamera,
  continuePath,
  onClose,
}: {
  /** Phase start endpoint, used to ensure a session row exists before generating handoff. */
  readonly startEndpoint: string | null;
  readonly autoMode: boolean;
  /**
   * True for identity (camera+selfie); drives the auto-mode header
   * ("Camera not available on this device"). False for address;
   * auto-mode collapses to the manual-mode header since address has
   * no camera reason to switch devices.
   */
  readonly requiresCamera: boolean;
  /**
   * OAuth-resume continueUrl, when non-null, posted as the start
   * endpoint's body so the new session row carries it through to
   * `/kyc/callback`. Without this, the QR-based handoff path would
   * silently drop the OAuth resume target the desktop start path
   * preserves.
   */
  readonly continuePath: string | null;
  readonly onClose: () => void;
}) {
  const [state, setState] = React.useState<HandoffState>({ status: 'loading' });
  const [copied, setCopied] = React.useState(false);

  /**
   * Run the full handoff prep:
   *
   *   1. POST `phase.startEndpoint`. Idempotent, returns the same
   *      hosted URL when a session already exists, so this is safe
   *      to call in both `start` and `continue` modes. We discard
   *      the redirect URL here; we are *not* navigating desktop to
   *      Didit on this path.
   *   2. POST /handoff. Generates a one-shot, 10-min, hashed-in-DB
   *      handoff token + QR code data URL. Backend picks the active
   *      session regardless of phase, so the same endpoint serves
   *      identity + address.
   *
   * Either step's failure surfaces as an inline retry in the panel.
   */
  const generateHandoff = React.useCallback(async () => {
    setState({ status: 'loading' });
    setCopied(false);

    if (startEndpoint === null) {
      setState({
        status: 'error',
        message: 'This step does not support phone handoff.',
      });
      return;
    }

    try {
      const startBody = continuePath !== null ? { continueUrl: continuePath } : null;
      const startRes = await fetch(startEndpoint, {
        method: 'POST',
        credentials: 'include',
        ...(startBody !== null
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(startBody),
            }
          : {}),
      });
      if (!startRes.ok) {
        const body = (await startRes.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        // 409 `kyc_mint_pending` is not a failure, Didit approved a
        // prior session and the mint is still in flight. Render a
        // calm "almost done" pane and let the parent page's SSE
        // listener pick up the kyc.status_changed event.
        if (body?.error?.code === 'kyc_mint_pending') {
          setState({ status: 'mint_pending' });
          return;
        }
        setState({
          status: 'error',
          message: body?.error?.message ?? 'Failed to prepare verification session.',
        });
        return;
      }

      const handoffRes = await fetch('/api/customer/kyc/handoff', {
        method: 'POST',
        credentials: 'include',
      });
      if (!handoffRes.ok) {
        const body = (await handoffRes.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setState({
          status: 'error',
          message: body?.error?.message ?? 'Failed to generate phone link.',
        });
        return;
      }
      const data = (await handoffRes.json()) as HandoffResponse;
      setState({
        status: 'ready',
        qrDataUrl: data.qrDataUrl,
        handoffUrl: data.handoffUrl,
        expiresAt: new Date(data.expiresAt),
      });
    } catch {
      setState({ status: 'error', message: 'Network error. Please try again.' });
    }
  }, [startEndpoint, continuePath]);

  // Kick off the handoff prep on mount.
  React.useEffect(() => {
    void generateHandoff();
  }, [generateHandoff]);

  // Flip to expired when the TTL elapses. The backend will reject
  // a consume on the expired token (410) but the UX shouldn't
  // require the user to scan-then-find-out, surface it client-side.
  React.useEffect(() => {
    if (state.status !== 'ready') return;
    const diff = state.expiresAt.getTime() - Date.now();
    if (diff <= 0) {
      setState({ status: 'expired' });
      return;
    }
    const id = setTimeout(() => setState({ status: 'expired' }), diff);
    return () => clearTimeout(id);
  }, [state]);

  const countdown = useCountdown(state.status === 'ready' ? state.expiresAt : null);

  const handleCopy = React.useCallback(async () => {
    if (state.status !== 'ready') return;
    try {
      await navigator.clipboard.writeText(state.handoffUrl);
      setCopied(true);
      toast.success('Phone link copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy link');
    }
  }, [state]);

  return (
    <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-border)]/60 bg-[var(--color-surface)]/50 p-4">
      {autoMode && requiresCamera ? (
        <div className="flex items-start gap-2">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]"
            aria-hidden="true"
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-[var(--color-fg)]">
              Camera not available on this device
            </p>
            <p className="text-xs text-[var(--color-muted)]">
              Scan the QR code with your phone to continue verification there.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-[var(--color-accent)]" aria-hidden="true" />
          <p className="text-sm font-medium text-[var(--color-fg)]">Continue on your phone</p>
        </div>
      )}

      {state.status === 'loading' && (
        <div className="flex flex-col items-center gap-2 py-4" aria-busy="true">
          <Loader2
            className="h-5 w-5 animate-spin text-[var(--color-accent)]"
            aria-hidden="true"
          />
          <p className="text-xs text-[var(--color-muted)]">Preparing phone link…</p>
        </div>
      )}

      {state.status === 'ready' && (
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-white p-2">
            {/* QR readers expect the QR on a high-contrast white
                background; using the surrounding theme bg drops scan
                reliability significantly. */}
            <img
              src={state.qrDataUrl}
              alt="QR code for device handoff"
              width={192}
              height={192}
              className="h-48 w-48"
            />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
            <span>Valid for</span>
            <span className="font-mono font-medium text-[var(--color-fg)]">{countdown}</span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => { void handleCopy(); }}
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                Copy link
              </>
            )}
          </Button>
        </div>
      )}

      {state.status === 'expired' && (
        <div className="flex flex-col items-center gap-2 py-3">
          <p className="text-xs text-[var(--color-muted)]">The phone link has expired.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => { void generateHandoff(); }}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Generate new link
          </Button>
        </div>
      )}

      {state.status === 'mint_pending' && (
        <div className="flex flex-col items-center gap-2 py-3">
          <p className="text-center text-xs text-[var(--color-fg)]" role="status">
            Verification approved. We&rsquo;re finalizing your credential
            on-chain &mdash; this usually takes a few seconds.
          </p>
          <p className="text-center text-xs text-[var(--color-muted)]">
            This page will update automatically when it&rsquo;s ready.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => { void generateHandoff(); }}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Refresh
          </Button>
        </div>
      )}

      {state.status === 'error' && (
        <div className="flex flex-col items-center gap-2 py-3">
          <p
            className="text-center text-xs text-[var(--color-danger)]"
            role="alert"
          >
            {state.message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => { void generateHandoff(); }}
          >
            <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </Button>
        </div>
      )}

      <div className="text-center">
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-[var(--color-muted)] underline-offset-2 hover:text-[var(--color-fg)] hover:underline"
        >
          {autoMode ? 'Cancel' : 'Back'}
        </button>
      </div>
    </div>
  );
}
