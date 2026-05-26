'use client';

import * as React from 'react';
import Link from 'next/link';
import { Skeleton } from '@/components/ui/skeleton';
import { NftShowcase } from '@/components/customer/nft-showcase';
import { useCredential } from '@/hooks/use-credential';
import { useKycEvents } from '@/hooks/use-kyc-events';

/* -------------------------------------------------------------------------- */
/*  Content skeleton (header always renders static, sektör pattern)          */
/* -------------------------------------------------------------------------- */

function NftContentSkeleton() {
  return <Skeleton className="h-72 w-full max-w-2xl" />;
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Soulbound NFT detail page.
 *
 * Single-purpose surface, the customer's on-chain artefact. The earlier
 * "Credential" front/back card (score ring + level badge + status text)
 * was retired because the same information already lives on `/kyc`
 * (verification stepper) and `/` (dashboard summary), so duplicating
 * it here added no signal and made the NFT harder to find. SSE keeps
 * the showcase in sync when an operator-side revoke or supersede burns
 * the bound NFT.
 */
export default function NftPage() {
  const { credential, isLoading, mutate } = useCredential();

  useKycEvents(
    React.useCallback(() => {
      void mutate();
    }, [mutate]),
  );

  const nft = credential?.nft ?? null;

  return (
    <div className="space-y-8">
      {/* Header, static, rendered immediately so the user lands on a known
          page even before credential data resolves. */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-fg)]">Your Crivacy NFT</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Your soulbound on-chain artefact - minted to Sepolia at verification time and bound to your
          active credential.
        </p>
      </div>

      {isLoading ? (
        <NftContentSkeleton />
      ) : nft !== null ? (
        <div className="max-w-5xl">
          <NftShowcase nft={nft} />
        </div>
      ) : (
        <div className="max-w-2xl rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-8 text-center">
          <p className="text-sm font-medium text-[var(--color-fg)]">No NFT minted yet.</p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Your soulbound NFT mints automatically once you complete identity and address
            verification.
          </p>
          <Link
            href="/kyc"
            className="mt-4 inline-flex items-center text-sm font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
          >
            Continue verification →
          </Link>
        </div>
      )}
    </div>
  );
}
