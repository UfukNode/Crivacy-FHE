'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface ScoreRingProps {
  readonly score: number;
  readonly maxScore: number;
  readonly size?: number;
  readonly strokeWidth?: number;
  readonly className?: string;
  /**
   * When true, renders a check icon in the centre instead of the
   * numeric score. Used for terminal kyc_4 state where the raw
   * `800 / 1000` value is misleading (suggests "80% complete" when in
   * fact the journey is over). Ring still fills 100% so the visual
   * indicator of "fully verified" is preserved.
   */
  readonly terminal?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Colour helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Map a 0-1 percentage to one of four colour tiers:
 *   0 – 25 %  → zinc-500 (muted)
 *  25 – 50 %  → emerald-700
 *  50 – 75 %  → amber-500 (warning)
 *  75 – 100 % → emerald-500
 */
function strokeColourForPercentage(pct: number): string {
  if (pct >= 0.75) return '#10b981';
  if (pct >= 0.5) return '#f59e0b';
  if (pct >= 0.25) return '#047857';
  return '#71717a';
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * SVG circular progress ring that displays a KYC score.
 *
 * The ring fills clockwise from the 12 o'clock position. The centre shows the
 * numeric score over the maximum (e.g. "350 / 1000"). The stroke colour changes
 * in four tiers based on the percentage filled.
 *
 * The progress transition uses CSS `transition` on `stroke-dashoffset` so the
 * ring animates smoothly when the score changes.
 */
export function ScoreRing({
  score,
  maxScore,
  size = 120,
  strokeWidth = 8,
  className,
  terminal = false,
}: ScoreRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  // In terminal mode the ring always fills 100%, at kyc_4 the journey
  // is complete, regardless of where the raw score sits inside the
  // tier scale.
  const percentage = terminal ? 1 : maxScore > 0 ? Math.min(score / maxScore, 1) : 0;
  const offset = circumference * (1 - percentage);
  const strokeColor = strokeColourForPercentage(percentage);

  const ariaLabel = terminal
    ? 'KYC verified'
    : `KYC score: ${score} out of ${maxScore}`;

  return (
    <div
      className={cn('relative inline-flex items-center justify-center', className)}
      role="img"
      aria-label={ariaLabel}
    >
      <svg
        width={size}
        height={size}
        className="-rotate-90"
        aria-hidden="true"
      >
        {/* Background track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={strokeWidth}
        />
        {/* Filled arc */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-1000 ease-out"
        />
      </svg>

      {/* Centre, check icon for terminal, score text otherwise */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {terminal ? (
          <Check
            className="h-10 w-10 text-[var(--color-success)]"
            strokeWidth={3}
            aria-hidden
          />
        ) : (
          <>
            <span className="text-2xl font-bold text-[var(--color-fg)]">{score}</span>
            <span className="text-[10px] text-[var(--color-muted)]">/ {maxScore}</span>
          </>
        )}
      </div>
    </div>
  );
}
