'use client';

import * as React from 'react';
import { Check, Lock, Clock, Loader2, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Step status union. Mirrors `phase-registry::StepStatus` for the
 * Didit-driven phases plus the stepper-only `available` status that
 * the legacy "Create Account" UI-only entry uses.
 *
 *   * `minting`, Didit decision is in, chain commit in flight.
 *     Renders an animated spinner marker so the customer sees the
 *     work continuing instead of either an inert ✓ (false positive)
 *     or a "Start verification" CTA (false negative).
 *   * `failed`, credential-pipeline retries exhausted. Red marker.
 */
export type KycStepStatus =
  | 'completed'
  | 'active'
  | 'available'
  | 'locked'
  | 'in_review'
  | 'minting'
  | 'failed';

/**
 * Sub-step status union. `in_progress` renders a pulsing accent dot
 * (drives the live "Issuing credential on Sepolia…" row), `failed`
 * renders a red X marker.
 */
export interface KycSubStep {
  readonly label: string;
  readonly status: 'completed' | 'pending' | 'in_progress' | 'failed';
}

export interface KycStep {
  readonly id: string;
  readonly label: string;
  /**
   * Step description. Accepts a ReactNode so callers can embed inline
   * affordances (e.g. a `<Link>` to the NFT tab inside the completed
   * state). Anything passed here renders inside a `<p>`, so block-level
   * children are not safe.
   */
  readonly description?: React.ReactNode;
  readonly status: KycStepStatus;
  readonly subSteps?: readonly KycSubStep[];
  readonly extraContent?: React.ReactNode;
}

interface KycStepperProps {
  readonly steps: readonly KycStep[];
}

/* -------------------------------------------------------------------------- */
/*  Marker, 24px fixed, sade, no pulse                                       */
/* -------------------------------------------------------------------------- */

function StepMarker({
  status,
  stepNo,
}: {
  readonly status: KycStepStatus;
  readonly stepNo: number;
}) {
  const base =
    'relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors';

  switch (status) {
    case 'locked':
      return (
        <div className={cn(base, 'border border-[var(--color-border)] bg-[var(--color-bg)]')}>
          <Lock className="h-3 w-3 text-[var(--color-muted)]" aria-hidden />
        </div>
      );
    case 'available':
      return (
        <div
          className={cn(
            base,
            'border border-[var(--color-border)] bg-[var(--color-bg)] text-[11px] font-semibold text-[var(--color-fg)]',
          )}
        >
          {stepNo}
        </div>
      );
    case 'active':
      return (
        <div
          className={cn(
            base,
            'bg-[var(--color-accent)] text-[11px] font-semibold text-[var(--color-accent-contrast)]',
          )}
        >
          {stepNo}
        </div>
      );
    case 'in_review':
      return (
        <div className={cn(base, 'bg-amber-500')}>
          <Clock className="h-3 w-3 text-white" aria-hidden />
        </div>
      );
    case 'minting':
      // Pulsing accent ring + spinning loader: signals on-chain commit
      // in flight (vs. amber clock used for off-chain Didit review).
      return (
        <div
          className={cn(
            base,
            'bg-[var(--color-accent)] text-[var(--color-accent-contrast)]',
          )}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin text-white" strokeWidth={3} aria-hidden />
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-[var(--color-accent)]/40 animate-pulse"
          />
        </div>
      );
    case 'failed':
      return (
        <div className={cn(base, 'bg-rose-500')}>
          <X className="h-3.5 w-3.5 text-white" strokeWidth={3} aria-hidden />
        </div>
      );
    case 'completed':
      return (
        <div className={cn(base, 'bg-[var(--color-success)]')}>
          <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} aria-hidden />
        </div>
      );
  }
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Vertical stepper. Connector sits behind the markers (z-index 0); the
 * marker has its own background so the line never visibly enters the
 * marker geometry. Active step is communicated by:
 *   - filled accent marker with the step number
 *   - bold label
 *   No row tint, no left bar, no pulse, minimalism on purpose.
 */
export function KycStepper({ steps }: KycStepperProps) {
  return (
    <ol className="space-y-0" role="list" aria-label="Verification steps">
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;

        const showSubSteps =
          step.subSteps !== undefined &&
          step.subSteps.length > 0 &&
          (step.status === 'active' ||
            step.status === 'in_review' ||
            step.status === 'minting' ||
            step.status === 'failed' ||
            step.status === 'completed');

        return (
          <li key={step.id} className="relative">
            {!isLast && (
              <span
                aria-hidden
                className="absolute left-[11px] top-7 z-0 h-[calc(100%-12px)] w-[2px] bg-[var(--color-border)]"
              />
            )}

            <div className="relative z-10 flex gap-3">
              <div className="flex pt-[2px]">
                <StepMarker status={step.status} stepNo={index + 1} />
              </div>

              <div className={cn('flex-1', !isLast && 'min-h-[72px] pb-7')}>
                <p
                  className={cn(
                    'text-sm leading-tight',
                    step.status === 'locked' && 'text-[var(--color-muted)]',
                    step.status === 'active' && 'font-semibold text-[var(--color-fg)]',
                    step.status === 'completed' && 'text-[var(--color-fg)]',
                    step.status === 'in_review' && 'text-[var(--color-fg)]',
                    step.status === 'minting' && 'font-semibold text-[var(--color-fg)]',
                    step.status === 'failed' && 'font-semibold text-rose-600 dark:text-rose-400',
                    step.status === 'available' && 'text-[var(--color-fg)]',
                  )}
                >
                  {step.label}
                </p>

                {step.description !== undefined && (
                  <p
                    className={cn(
                      'mt-0.5 text-xs',
                      step.status === 'locked'
                        ? 'text-[var(--color-muted)]/70'
                        : 'text-[var(--color-muted)]',
                    )}
                  >
                    {step.description}
                  </p>
                )}

                {showSubSteps && step.subSteps !== undefined && (
                  <ul className="mt-2 space-y-1">
                    {step.subSteps.map((sub) => (
                      <li
                        key={sub.label}
                        className={cn(
                          'flex items-center gap-1.5 text-xs',
                          sub.status === 'failed'
                            ? 'text-rose-600 dark:text-rose-400'
                            : sub.status === 'in_progress'
                              ? 'text-[var(--color-fg)]'
                              : 'text-[var(--color-muted)]',
                        )}
                      >
                        {sub.status === 'completed' ? (
                          <Check
                            className="h-3 w-3 text-[var(--color-success)]"
                            strokeWidth={3}
                            aria-hidden
                          />
                        ) : sub.status === 'failed' ? (
                          <X
                            className="h-3 w-3 text-rose-500"
                            strokeWidth={3}
                            aria-hidden
                          />
                        ) : sub.status === 'in_progress' ? (
                          // Pulsing WARNING-token dot (amber/orange).
                          // Brand accent is green (`#047857`), which
                          // reads as "completed" next to the green
                          // Check icons used above. Using
                          // `--color-warning` keeps the SoT (no
                          // hard-coded hex) while giving the row a
                          // distinct "active work, not done yet"
                          // signal, same semantic the in-review
                          // step marker already uses (amber clock).
                          <span
                            aria-hidden
                            className="relative inline-flex h-1.5 w-1.5 shrink-0"
                          >
                            <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--color-warning)] opacity-60 animate-ping" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--color-warning)]" />
                          </span>
                        ) : (
                          <span
                            aria-hidden
                            className="h-1.5 w-1.5 rounded-full bg-[var(--color-border)]"
                          />
                        )}
                        {sub.label}
                      </li>
                    ))}
                  </ul>
                )}

                {step.extraContent !== undefined && (
                  <div className="mt-3">{step.extraContent}</div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
