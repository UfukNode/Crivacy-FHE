'use client';

import * as React from 'react';
import Tilt from 'react-parallax-tilt';

import { cn } from '@/lib/utils';
import type { CredentialNft } from '@/hooks/use-credential';
import { NftLightbox } from '@/components/customer/nft-lightbox';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface NftShowcaseProps {
  readonly nft: CredentialNft;
  readonly chainNetwork?: string;
  readonly className?: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Format an ISO date for the "Issued" line. Falls back to the raw
 * value if the input cannot be parsed, better to show something than
 * silently render a blank.
 */
function formatIssuedAt(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Truncate a on-chain contract id for display: first 6 + ellipsis +
 * last 4 hex chars. The full id is preserved as the `title` so a hover
 * reveals it.
 */
function truncateContractId(cid: string): string {
  if (cid.length <= 14) {
    return cid;
  }
  return `${cid.slice(0, 6)}…${cid.slice(-4)}`;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Soulbound NFT showcase panel. Rendered below the credential card
 * for Enhanced (kyc_4) customers whose NFT has been minted on chain.
 *
 * The image is an inline `data:image/svg+xml;base64,…` URI built
 * server-side from the same template the on-chain `image` field
 * carries. XSS defence is layered:
 *
 *   1. DOMPurify pre-mint sanitisation in the worker
 *      (`@/lib/nft/build-nft.ts`).
 *   2. CSP `img-src 'self' data:` in the customer middleware.
 *   3. Browser `<img>` element sandbox, `data:image/svg+xml` URIs
 *      rendered through `<img src>` cannot execute JavaScript.
 *
 * The component is read-only: customers cannot transfer, burn, or
 * otherwise mutate the artefact from this surface. Soulbound at the
 * contract level (transfer and burn are disabled on-chain) so this is a
 * UI assertion, not a primary defence.
 */
export function NftShowcase({ nft, chainNetwork, className }: NftShowcaseProps) {
  const issued = formatIssuedAt(nft.mintedAt);
  const [zoomOpen, setZoomOpen] = React.useState(false);

  return (
    <section
      aria-labelledby="nft-showcase-heading"
      className={cn(
        'w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-6 shadow-sm sm:p-8 md:p-10',
        className,
      )}
    >
      {/* The NFT artefact itself, no inner panel; the SVG carries its
          own shadow + cyan border + rounded corners. Tilt is the sole
          hover affordance, click opens the zoom overlay. */}
      <Tilt
        tiltMaxAngleX={8}
        tiltMaxAngleY={10}
        glareEnable
        glareMaxOpacity={0.18}
        glareColor="#9bdcff"
        glarePosition="all"
        glareBorderRadius="32px"
        scale={1.02}
        transitionSpeed={1100}
        gyroscope={false}
        className="mx-auto block w-full max-w-[640px]"
      >
        <button
          type="button"
          aria-label="Open NFT image at full size"
          onClick={() => setZoomOpen(true)}
          className="block aspect-[1280/800] w-full cursor-zoom-in bg-transparent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-accent)]"
        >
          <img
            src={nft.image}
            alt={nft.displayName}
            className="h-full w-full select-none object-contain"
            draggable={false}
            referrerPolicy="no-referrer"
          />
        </button>
      </Tilt>

      {/* Horizontal separator between the artefact and the metadata
          strip. Built as a transparent → border → transparent gradient
          so the line has volumetric falloff at both ends rather than a
          hard hairline edge. */}
      <hr
        aria-hidden
        className="my-8 h-px border-0"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, var(--color-border) 20%, var(--color-border) 80%, transparent 100%)',
        }}
      />

      {/* Metadata row, labels and values without colons; vertical
          gradient separators between the three groups, fading at the
          top and bottom for a soft 3D edge instead of a flat rule. */}
      <dl className="mx-auto flex max-w-[640px] flex-wrap items-center justify-center gap-x-6 gap-y-3 text-xs">
        <div className="flex items-baseline gap-2">
          <dt className="uppercase tracking-[0.18em] text-[var(--color-muted)]">Serial</dt>
          <dd className="font-mono text-[var(--color-fg)]">{nft.serialNumber}</dd>
        </div>
        <span
          aria-hidden
          className="hidden h-7 w-px sm:block"
          style={{
            background:
              'linear-gradient(180deg, transparent 0%, var(--color-border) 35%, var(--color-border) 65%, transparent 100%)',
          }}
        />
        <div className="flex items-baseline gap-2">
          <dt className="uppercase tracking-[0.18em] text-[var(--color-muted)]">Issued</dt>
          <dd className="tabular-nums text-[var(--color-fg)]">{issued}</dd>
        </div>
        <span
          aria-hidden
          className="hidden h-7 w-px sm:block"
          style={{
            background:
              'linear-gradient(180deg, transparent 0%, var(--color-border) 35%, var(--color-border) 65%, transparent 100%)',
          }}
        />
        <div className="flex items-baseline gap-2">
          <dt className="uppercase tracking-[0.18em] text-[var(--color-muted)]">Contract</dt>
          <dd
            className="font-mono text-[var(--color-fg)]"
            title={nft.contractId}
          >
            {truncateContractId(nft.contractId)}
            {chainNetwork === 'mainnet' && (
              <span className="ml-1.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]">
                mainnet
              </span>
            )}
          </dd>
        </div>
      </dl>

      <p className="mx-auto mt-5 max-w-[640px] text-center text-xs text-[var(--color-muted)]">
        Soulbound. Bound to your active credential and burned on chain
        when the credential is revoked.
      </p>

      <NftLightbox
        open={zoomOpen}
        image={nft.image}
        alt={nft.displayName}
        onClose={() => setZoomOpen(false)}
      />
    </section>
  );
}
