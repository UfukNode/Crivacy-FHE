'use client';

import * as React from 'react';
import Link from 'next/link';
import { Check, Lock, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import {
  ADDRESS_PHASE,
  IDENTITY_PHASE,
  NFT_MINT_PHASE,
  isCustomerKycLevel,
  type CustomerKycLevel,
} from '@/lib/kyc/phase-registry';

interface OnboardingStep {
  label: string;
  completed: boolean;
  locked: boolean;
  href: string | null;
  actionLabel: string | null;
}

interface OnboardingChecklistProps {
  /** Customer's email verified timestamp (null if not verified) */
  readonly emailVerifiedAt: string | null;
  /** Whether the customer has an email set (false for wallet-only users) */
  readonly hasEmail: boolean;
  /** Customer's KYC level string like 'kyc_0', 'kyc_1', etc. */
  readonly kycLevel: string;
  /** Whether the checklist has been dismissed */
  readonly dismissed: boolean;
  /** Called when dismiss is clicked */
  readonly onDismiss: () => void;
}

export function OnboardingChecklist({
  emailVerifiedAt,
  hasEmail,
  kycLevel,
  dismissed,
  onDismiss,
}: OnboardingChecklistProps) {
  if (dismissed) return null;

  // Sprint 9: derive step status off the phase registry instead of
  // hardcoded `levelNum >= N` thresholds. Each phase's
  // `resolveStepStatus(state)` returns 'locked' | 'active' |
  // 'in_review' | 'completed', and the checklist maps that to the
  // local two-state (completed / locked) shape.
  const safeLevel: CustomerKycLevel = isCustomerKycLevel(kycLevel) ? kycLevel : 'kyc_0';
  const phaseState = {
    customerKycLevel: safeLevel,
    hasActiveSession: false,
    inReview: false,
    // Onboarding checklist surfaces phase status only at the
    // two-state (completed / locked) granularity; sub-step in-flight
    // visuals belong to the /kyc step page. `false` collapses the
    // registry's in-flight branch.
    sessionInFlight: false,
    nftContractId: null,
    // Onboarding checklist drives off-page summaries (not the live
    // mint stepper) so it never sits inside the Didit-approved →
    // chain-mint window. `null` collapses the registry's mint-aware
    // branch and falls back to the level-based status the checklist
    // already maps to its two-state shape.
    mintProgress: null,
  };
  const identityStatus = IDENTITY_PHASE.resolveStepStatus(phaseState);
  const addressStatus = ADDRESS_PHASE.resolveStepStatus(phaseState);
  const mintStatus = NFT_MINT_PHASE.resolveStepStatus(phaseState);

  const emailVerified = emailVerifiedAt !== null;

  // Wallet-only users (no email) can skip email verification entirely
  const emailStepComplete = !hasEmail || emailVerified;

  const identityCompleted = identityStatus === 'completed';
  const addressCompleted = addressStatus === 'completed';
  const mintCompleted = mintStatus === 'completed';

  const steps: OnboardingStep[] = [
    {
      label: 'Create your account',
      completed: true, // always completed if they're seeing this
      locked: false,
      href: null,
      actionLabel: null,
    },
    // Only show email verification step if user has an email
    ...(hasEmail
      ? [
          {
            label: 'Verify your email',
            completed: emailVerified,
            locked: false,
            href: emailVerified ? null : '/settings',
            actionLabel: 'Verify',
          },
        ]
      : []),
    {
      label: 'Complete identity verification',
      completed: identityCompleted,
      locked: !emailStepComplete,
      href: identityCompleted ? null : '/kyc',
      actionLabel: 'Start',
    },
    {
      label: 'Complete address verification',
      completed: addressCompleted,
      locked: addressStatus === 'locked',
      // Sprint 10: `/kyc/address` standalone page deleted; address
      // verification is now a step inside the unified `/kyc` page
      // (same parity with `/kyc/identity` which K2 deleted earlier).
      // Both phases render the registry-driven `KycActionPanel`,
      // which is the only entry point.
      href: addressCompleted ? null : '/kyc',
      actionLabel: 'Start',
    },
    {
      label: 'View your soulbound NFT',
      // NFT step "completed" here = on-chain enhanced credential; the
      // mint phase itself is `active` until the NFT contract id is
      // stamped (theme picker on /kyc step 4). The checklist tracks
      // the higher-level milestone, not the per-mint state.
      completed: addressCompleted,
      locked: !addressCompleted,
      href: addressCompleted ? '/credential' : null,
      actionLabel: 'View',
    },
  ];
  // `mintCompleted` is intentionally not surfaced here, the
  // checklist's "soulbound NFT" entry tracks the kyc_4 milestone,
  // not the per-mint contract-id stamp. Touched explicitly so the
  // linter doesn't strip the resolver call above (which serves as a
  // load-bearing exhaustiveness check on the NFT phase resolver).
  void mintCompleted;

  const completedCount = steps.filter((s) => s.completed).length;
  const totalCount = steps.length;
  const progressPct = Math.round((completedCount / totalCount) * 100);

  if (completedCount === totalCount) return null; // All done, hide naturally

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between pb-3">
        <div>
          <CardTitle className="text-base">Welcome to Crivacy!</CardTitle>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Complete these steps to get started.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDismiss}
          aria-label="Dismiss onboarding checklist"
          className="h-8 w-8"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress bar */}
        <div className="space-y-1">
          <Progress value={progressPct} className="h-2" />
          <p className="text-xs text-[var(--color-muted)]">
            {completedCount}/{totalCount} complete
          </p>
        </div>

        {/* Steps */}
        <ul className="space-y-2">
          {steps.map((step) => (
            <li key={step.label} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {step.completed ? (
                  <Check className="h-4 w-4 text-[var(--color-success)]" aria-hidden="true" />
                ) : step.locked ? (
                  <Lock className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />
                ) : (
                  <div className="h-4 w-4 rounded-full border-2 border-[var(--color-border)]" aria-hidden="true" />
                )}
                <span
                  className={cn(
                    'text-sm',
                    step.completed
                      ? 'text-[var(--color-fg)]'
                      : step.locked
                        ? 'text-[var(--color-muted)]'
                        : 'text-[var(--color-fg)]',
                  )}
                >
                  {step.label}
                </span>
              </div>
              {!step.completed && !step.locked && step.href !== null && (
                <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                  <Link href={step.href}>{step.actionLabel ?? 'Start'}</Link>
                </Button>
              )}
              {step.completed && (
                <span className="text-xs text-[var(--color-success)]">Done</span>
              )}
              {!step.completed && step.locked && (
                <span className="text-xs text-[var(--color-muted)]">Locked</span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
