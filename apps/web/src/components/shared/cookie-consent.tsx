'use client';

import * as React from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Essential-only cookie consent banner.
 *
 * We deliberately use ONLY httpOnly session cookies (customer / firm /
 * admin auth tokens + OAuth nonces). No tracking / analytics cookies
 * are set, so "strictly necessary" exemption applies under most
 * EU/UK/TR interpretations. The banner still surfaces because:
 *
 *   - Good-faith transparency, the subject sees what we set even
 *     if legally we don't need consent for it.
 *   - Privacy Policy link, single-click discovery of the full
 *     practice (AUD-X-COMP-007 fix).
 *   - Dismiss without accept, closing with the X stores the same
 *     flag, suppresses re-show. No "reject" UI because there's
 *     nothing to reject.
 *
 * localStorage flag survives future layout changes; we never migrate
 * this flag to a cookie because that would itself need consent.
 *
 * Legacy flag value `'accepted'` (from pre-COMP-7) is treated as
 * `'dismissed'` so upgrading users don't see the banner again.
 */
const STORAGE_KEY = 'crivacy_cookie_consent';

export function CookieConsent() {
  const [show, setShow] = React.useState(false);

  React.useEffect(() => {
    const consent = localStorage.getItem(STORAGE_KEY);
    // Accept both 'accepted' (legacy) and 'dismissed' (current) so
    // returning users don't re-see the banner after an upgrade.
    if (consent !== 'dismissed' && consent !== 'accepted') {
      setShow(true);
    }
  }, []);

  const handleDismiss = React.useCallback(() => {
    localStorage.setItem(STORAGE_KEY, 'dismissed');
    setShow(false);
  }, []);

  if (!show) return null;

  return (
    <div
      className="fixed bottom-[max(1.5rem,calc(1.5rem+env(safe-area-inset-bottom)))] left-1/2 z-50 -translate-x-1/2 w-[min(40rem,calc(100vw-2rem))] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl safe-bottom"
      role="region"
      aria-label="Cookie notice"
    >
      <div className="flex items-start gap-4 px-6 py-5">
        <div className="flex-1 space-y-1.5">
          <p className="text-sm font-medium text-[var(--color-fg)]">
            Essential cookies only
          </p>
          <p className="text-xs leading-normal text-[var(--color-muted)]">
            We use httpOnly session cookies required to keep you signed in, nothing for
            analytics or advertising. See our{' '}
            <Link
              href="/privacy"
              className="inline-flex min-h-[44px] items-center text-[var(--color-accent)] underline-offset-2 hover:underline"
            >
              Privacy Policy
            </Link>{' '}
            for the full practice.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            onClick={handleDismiss}
            size="sm"
            className="min-h-[44px] px-4"
            aria-label="Got it, dismiss"
          >
            Got it
          </Button>
          <button
            type="button"
            onClick={handleDismiss}
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)]"
            aria-label="Dismiss notice"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
