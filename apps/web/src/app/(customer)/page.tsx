'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, ShieldCheck, Sparkles, HelpCircle, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScoreRing } from '@/components/customer/score-ring';
import { LevelBadge } from '@/components/customer/level-badge';
import { OnboardingChecklist } from '@/components/shared/onboarding-checklist';
import { useKycStatus } from '@/hooks/use-kyc-status';
import { useKycEvents } from '@/hooks/use-kyc-events';
import { useCustomerProfile } from '@/hooks/use-customer-profile';
import { isActiveSessionStatus } from '@/lib/kyc/session-status-display';
import {
  ADDRESS_PHASE,
  IDENTITY_PHASE,
  isCustomerKycLevel,
  type CustomerKycLevel,
  type PhaseStateInput,
} from '@/lib/kyc/phase-registry';
import type { KycStatus } from '@crivacy/shared-types';

/* -------------------------------------------------------------------------- */
/*  Content skeleton (header always renders static, sektör pattern)          */
/* -------------------------------------------------------------------------- */

function DashboardContentSkeleton() {
  return (
    <>
      <div className="grid gap-6 sm:grid-cols-2">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Quick-link card                                                           */
/* -------------------------------------------------------------------------- */

function QuickLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  readonly href: string;
  readonly icon: React.ComponentType<{ readonly className?: string }>;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <Link href={href} className="group">
      <Card className="transition-colors hover:border-[var(--color-accent)]">
        <CardContent className="flex items-center gap-3 p-4">
          <Icon className="h-5 w-5 text-[var(--color-accent)]" />
          <div>
            <p className="text-sm font-medium text-[var(--color-fg)]">{title}</p>
            <p className="text-xs text-[var(--color-muted)]">{description}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Customer dashboard, the main page after login.
 *
 * Shows:
 * - Score ring with current KYC score
 * - Level badge
 * - Quick-action card (Start / Continue / View Credential)
 * - Quick-link grid (Verification, Credential, Support)
 *
 * Listens for SSE events to revalidate KYC data in real time.
 */
export default function CustomerDashboardPage() {
  const { status, isLoading, mutate } = useKycStatus();
  const { profile } = useCustomerProfile();

  // Onboarding dismiss state: server-side via onboardingDismissedAt, localStorage fallback
  const [onboardingDismissed, setOnboardingDismissed] = React.useState(true); // default true to avoid flash

  React.useEffect(() => {
    if (profile !== null) {
      if (profile.onboardingDismissedAt !== null) {
        setOnboardingDismissed(true);
        return;
      }
    }
    const stored = localStorage.getItem('crivacy_onboarding_dismissed');
    if (stored === 'true') {
      setOnboardingDismissed(true);
    } else if (profile !== null) {
      // Profile loaded and not dismissed on server or localStorage
      setOnboardingDismissed(false);
    }
  }, [profile]);

  const handleDismissOnboarding = React.useCallback(() => {
    setOnboardingDismissed(true);
    localStorage.setItem('crivacy_onboarding_dismissed', 'true');
    fetch('/api/customer/profile', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboardingDismissed: true }),
    }).catch(() => {
      /* silent fail for dismiss persistence */
    });
  }, []);

  // Revalidate KYC status whenever an SSE event arrives
  useKycEvents(
    React.useCallback(() => {
      void mutate();
    }, [mutate]),
  );

  const kycLevel = status?.kycLevel ?? 'kyc_0';
  const kycScore = status?.kycScore ?? 0;
  const rawLevelName = status?.levelName ?? 'Unverified';
  const nextLevelName = status?.nextLevelName;
  const maxScore = status?.maxScore ?? 1000;

  // Sprint 9: drive every level-gate off the phase registry.
  // `levelNum` (numeric form) is no longer needed, the registry's
  // `resolveStepStatus` returns the same boolean states the dashboard
  // CTA picks between, sourced from the same SoT the /kyc page uses.
  const safeLevel: CustomerKycLevel = isCustomerKycLevel(kycLevel) ? kycLevel : 'kyc_0';
  const phaseStateForCta: PhaseStateInput = {
    customerKycLevel: safeLevel,
    hasActiveSession: false,
    inReview: false,
    // Dashboard CTA is level-based only, sub-step in-flight visuals
    // belong to the /kyc step page, not the lightweight CTA card.
    sessionInFlight: false,
    nftContractId: null,
    // Dashboard CTA renders off the level-based status only; it
    // never claims to surface the live mint window (the /kyc step
    // page owns that signal). `null` collapses the registry's
    // mint-aware branch.
    mintProgress: null,
  };
  const identityStatus = IDENTITY_PHASE.resolveStepStatus(phaseStateForCta);
  const addressStatus = ADDRESS_PHASE.resolveStepStatus(phaseStateForCta);

  // Terminal flag overrides every other CTA / status string. At kyc_4
  // the journey is complete and any lingering session row from a past
  // resumption attempt should not flip the CTA back to "in progress" -
  // that contradicts the verified state shown by the score ring + level
  // badge.
  const isVerified = addressStatus === 'completed';

  // Surface the highest-priority "needs attention" state so the CTA
  // and the inline alert can both reason about it. kyc_expired wins
  // over resubmission_pending wins over in_review, they each demand
  // a different next step from the customer.
  const sessions = status?.sessions ?? [];
  const hasKycExpired = sessions.some((s) => s.status === 'kyc_expired');
  const hasResubmission = sessions.some((s) => s.status === 'resubmission_pending');
  const hasInReview = sessions.some((s) => s.status === 'in_review');
  const resumeUrl =
    sessions.find((s) => s.status === 'resubmission_pending' && s.redirectUrl !== null)
      ?.redirectUrl ?? null;

  // Determine CTA based on current state. `hasActiveSession` is only
  // meaningful pre-verification; once the customer is verified we
  // ignore session state entirely. `isActiveSessionStatus` is the
  // shared predicate from `lib/kyc/session-status-display`, adding
  // a new status to that helper automatically widens this gate.
  const hasActiveSession =
    !isVerified &&
    sessions.some((s) => isActiveSessionStatus(s.status as KycStatus));
  // CTA branches:
  //   * needsIdentity, identity phase is `active` (kyc_0 / kyc_1).
  //   * needsLiveness, identity is `in_review` (kyc_2 / Didit owns
  //                     the document-parsed-but-liveness-pending state).
  //   * needsAddress , address phase is `active` (kyc_3, identity done).
  const needsIdentity = identityStatus === 'active';
  const needsLiveness = identityStatus === 'in_review';
  const needsAddress = addressStatus === 'active';
  // Show the raw level name throughout, including at completion. The
  // earlier "Verified" override hid the actual tier (e.g. "Enhanced")
  // behind a generic copy-paste success label. Keeps the dashboard in
  // sync with /kyc which now also shows the raw level name end-to-end.
  const displayLevelName = rawLevelName;

  return (
    <div className="space-y-8">
      {/* Header, static, rendered immediately so the user lands on a known
          page even before KYC status resolves. */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-fg)]">Dashboard</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Your verification status and credential overview.
        </p>
      </div>

      {isLoading ? (
        <DashboardContentSkeleton />
      ) : (
        <>
          {/* Onboarding checklist */}
          <OnboardingChecklist
            emailVerifiedAt={profile?.emailVerifiedAt ?? null}
            hasEmail={profile?.email !== null && profile?.email !== undefined}
            kycLevel={kycLevel}
            dismissed={onboardingDismissed}
            onDismiss={handleDismissOnboarding}
          />

          {/* Needs-attention alert, kyc_expired wins over
              resubmission_pending wins over in_review. Each maps to a
              different next step the customer needs to take, so the
              banner copy + CTA differs. The /kyc page surfaces the
              same statuses with a richer banner (with the per-feature
              resubmit list); this dashboard variant is the compact
              "you have something to do" pointer. */}
          {(hasKycExpired || hasResubmission || hasInReview) && (
            <Card
              role="status"
              aria-live="polite"
              className={
                hasKycExpired
                  ? 'border-rose-500/40 bg-rose-500/5'
                  : 'border-amber-500/40 bg-amber-500/5'
              }
            >
              <CardContent className="flex items-start gap-3 p-4 sm:items-center sm:gap-4">
                <AlertTriangle
                  className={
                    hasKycExpired
                      ? 'h-5 w-5 shrink-0 text-rose-600'
                      : 'h-5 w-5 shrink-0 text-amber-600'
                  }
                  aria-hidden="true"
                />
                <div className="flex-1">
                  <p className="text-sm font-medium text-[var(--color-fg)]">
                    {hasKycExpired
                      ? 'Your verified identity has expired.'
                      : hasResubmission
                        ? 'Some verification steps need to be redone.'
                        : 'Your verification is under manual review.'}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {hasKycExpired
                      ? 'Your KYC credential reached its expiration date, re-verify to continue using verified services.'
                      : hasResubmission
                        ? 'Resume the flagged steps in the verification flow, your earlier submissions are saved.'
                        : 'Our compliance team is reviewing your submission. This typically takes 24-48 hours; no action is needed right now.'}
                  </p>
                </div>
                {hasResubmission && resumeUrl !== null ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      window.location.href = resumeUrl;
                    }}
                  >
                    Resume <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <Button asChild size="sm" variant={hasKycExpired ? 'default' : 'outline'}>
                    <Link href="/kyc">
                      {hasKycExpired ? 'Re-verify' : 'View details'}
                      <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          {/* Score + Level / Quick action */}
          <div className="grid gap-6 sm:grid-cols-2">
            {/* Score card */}
            <Card>
              <CardContent className="flex items-center gap-6 p-6">
                <ScoreRing score={kycScore} maxScore={maxScore} />
                <div className="space-y-2">
                  <LevelBadge level={kycLevel} levelName={displayLevelName} />
                  <p className="text-sm text-[var(--color-muted)]">
                    {isVerified
                      ? 'You are fully verified.'
                      : nextLevelName
                        ? `Next level: ${nextLevelName}`
                        : 'Maximum level reached'}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* CTA card, branch order matches the priority used by the
                attention banner above so the two stay in sync.
                Verified > kyc_expired > resubmission > in_review >
                regular active session > start. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {isVerified
                    ? 'Verification Complete'
                    : hasKycExpired
                      ? 'Re-verify Required'
                      : hasResubmission
                        ? 'Resubmission Required'
                        : hasInReview
                          ? 'Under Manual Review'
                          : hasActiveSession
                            ? 'Verification In Progress'
                            : needsIdentity
                              ? 'Start Verification'
                              : needsLiveness
                                ? 'Continue Identity Check'
                                : needsAddress
                                  ? 'Complete Address Verification'
                                  : 'Continue Verification'}
                </CardTitle>
                <CardDescription>
                  {isVerified
                    ? 'Your soulbound NFT is minted and bound to your active credential.'
                    : hasKycExpired
                      ? 'Your KYC credential reached its expiration, start a new verification.'
                      : hasResubmission
                        ? 'Resume your verification to redo the steps flagged by compliance.'
                        : hasInReview
                          ? 'Compliance is reviewing your submission. You will be notified when the review completes.'
                          : hasActiveSession
                            ? 'Your verification is being processed.'
                            : needsIdentity
                              ? 'Verify your identity to unlock your credential.'
                              : needsLiveness
                                ? 'Complete the liveness check to advance to address verification.'
                                : needsAddress
                                  ? 'Add address verification to increase your level.'
                                  : 'Continue your verification flow.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isVerified ? (
                  <Button asChild variant="outline" className="w-full">
                    <Link href="/credential">
                      View NFT <Sparkles className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                ) : hasResubmission && resumeUrl !== null ? (
                  <Button
                    className="w-full"
                    onClick={() => {
                      window.location.href = resumeUrl;
                    }}
                  >
                    Resume Verification <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                ) : hasKycExpired || hasInReview || hasActiveSession ? (
                  <Button asChild variant="outline" className="w-full">
                    <Link href="/kyc">
                      View Status <ArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                ) : (
                  <Button asChild className="w-full">
                    <Link href="/kyc">
                      {needsIdentity
                        ? 'Start Verification'
                        : needsLiveness
                          ? 'Continue'
                          : needsAddress
                            ? 'Verify Address'
                            : 'Continue'}
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Quick links */}
          <div className="grid gap-4 sm:grid-cols-3">
            <QuickLink
              href="/kyc"
              icon={ShieldCheck}
              title="Verification"
              description="Check your KYC progress"
            />
            <QuickLink
              href="/credential"
              icon={Sparkles}
              title="NFT"
              description="View your soulbound NFT"
            />
            <QuickLink
              href="/tickets"
              icon={HelpCircle}
              title="Support"
              description="Get help with verification"
            />
          </div>
        </>
      )}
    </div>
  );
}
