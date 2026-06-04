'use client';

import * as React from 'react';
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PASSWORD_MIN_LENGTH } from '@/lib/validation/auth';

interface PasswordStrengthProps {
  password: string;
  className?: string;
}

interface StrengthResult {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
}

const SCORE_CONFIG: Record<number, { label: string; color: string; width: string }> = {
  0: { label: 'Very weak', color: 'var(--color-danger)', width: '20%' },
  1: { label: 'Weak', color: 'var(--color-danger)', width: '40%' },
  2: { label: 'Fair', color: 'var(--color-warning)', width: '60%' },
  3: { label: 'Strong', color: 'var(--color-success)', width: '80%' },
  4: { label: 'Very strong', color: 'var(--color-success)', width: '100%' },
};

const REQUIREMENTS = [
  {
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    test: (p: string) => p.length >= PASSWORD_MIN_LENGTH,
  },
  { label: 'Contains uppercase letter', test: (p: string) => /[A-Z]/.test(p) },
  { label: 'Contains number', test: (p: string) => /\d/.test(p) },
  { label: 'Contains special character', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
] as const;

/**
 * Compute password strength score without zxcvbn (lazy-loaded).
 * Falls back to requirement-based scoring. zxcvbn loaded on first render.
 */
function computeScore(password: string): StrengthResult {
  if (!password) return { score: 0, label: 'Very weak' };

  let score = 0;
  if (password.length >= PASSWORD_MIN_LENGTH) score++;
  if (password.length >= PASSWORD_MIN_LENGTH + 4) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  if (password.length >= PASSWORD_MIN_LENGTH + 8) score++;

  // Common patterns penalty
  if (/^[a-z]+$/i.test(password)) score = Math.max(score - 2, 0);
  if (/^[0-9]+$/.test(password)) score = Math.max(score - 2, 0);
  if (/(.)\1{2,}/.test(password)) score = Math.max(score - 1, 0);
  if (/^(123|abc|qwe|pass|1234)/i.test(password)) score = Math.max(score - 2, 0);

  const clamped = Math.min(Math.max(score, 0), 4) as 0 | 1 | 2 | 3 | 4;
  return { score: clamped, label: SCORE_CONFIG[clamped]!.label };
}

/**
 * Password strength meter with progress bar + requirements checklist.
 * Score 0-4 → color bar (red/orange/yellow/green).
 * Applied on: register, change password, reset password.
 */
export function PasswordStrength({ password, className }: PasswordStrengthProps) {
  const { score } = computeScore(password);
  const config = SCORE_CONFIG[score]!;

  if (!password) return null;

  return (
    <div className={cn('space-y-2', className)}>
      {/* Strength bar */}
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-border)]">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: config.width, backgroundColor: config.color }}
            role="progressbar"
            aria-valuenow={score}
            aria-valuemin={0}
            aria-valuemax={4}
            aria-label={`Password strength: ${config.label}`}
          />
        </div>
        <span className="text-xs font-medium" style={{ color: config.color }}>
          {config.label}
        </span>
      </div>

      {/* Requirements checklist */}
      <ul className="space-y-1">
        {REQUIREMENTS.map((req) => {
          const met = req.test(password);
          return (
            <li key={req.label} className="flex items-center gap-1.5 text-xs">
              {met ? (
                <Check className="h-3 w-3 text-[var(--color-success)]" aria-hidden="true" />
              ) : (
                <X className="h-3 w-3 text-[var(--color-muted)]" aria-hidden="true" />
              )}
              <span className={cn(met ? 'text-[var(--color-fg)]' : 'text-[var(--color-muted)]')}>
                {req.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Check if password meets ALL 4 requirements shown in the UI checklist. */
export function isPasswordStrong(password: string): boolean {
  return REQUIREMENTS.every((req) => req.test(password));
}
