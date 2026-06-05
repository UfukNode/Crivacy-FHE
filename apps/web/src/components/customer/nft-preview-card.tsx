'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

interface NftPreviewCardProps {
  readonly className?: string;
}

/**
 * Pre-mint preview of the soulbound KYC NFT. Fetches the same SVG
 * template the worker uses at mint time (`public/static/nft/enhanced.svg`)
 * and substitutes the placeholder tokens (`{{SERIAL}}`, `{{ISSUED_AT}}`)
 * with pre-mint copy ("Pending" / "—"). Substituting client-side keeps
 * the design canvas as a single source of truth, no separate preview
 * SVG to maintain, while never leaking the literal `{{TOKEN}}` strings
 * to the user.
 *
 * Visual treatment:
 *   - Grayscale + shimmer overlay → unminted state
 *   - 1:1 square (matches the on-chain 600x600 viewBox)
 *   - `prefers-reduced-motion: reduce` disables the shimmer
 *
 * Once the credential mints, the parent removes this preview and the
 * minted NFT chip surfaces in the chain-events branch.
 */
const PREVIEW_SERIAL = 'Pending';
const PREVIEW_ISSUED_AT = '-';

export function NftPreviewCard({ className }: NftPreviewCardProps) {
  const [previewSrc, setPreviewSrc] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/static/nft/enhanced.svg', { credentials: 'omit' });
        if (!res.ok) return;
        const raw = await res.text();
        const filled = raw
          .replace(/\{\{SERIAL\}\}/g, PREVIEW_SERIAL)
          .replace(/\{\{ISSUED_AT\}\}/g, PREVIEW_ISSUED_AT);
        const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(filled)}`;
        if (!cancelled) setPreviewSrc(dataUri);
      } catch {
        // Silent fall-through, placeholder remains a blank shimmer card.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <style>{`
        @keyframes nft-preview-shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .nft-preview-shimmer-overlay {
          background: linear-gradient(
            110deg,
            transparent 30%,
            rgba(255, 255, 255, 0.18) 45%,
            rgba(255, 255, 255, 0.32) 50%,
            rgba(255, 255, 255, 0.18) 55%,
            transparent 70%
          );
          mix-blend-mode: screen;
          animation: nft-preview-shimmer 2.6s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .nft-preview-shimmer-overlay { animation: none; }
        }
      `}</style>

      <div
        aria-label="Soulbound KYC NFT, not yet minted"
        className={cn(
          'relative aspect-square w-[260px] overflow-hidden rounded-xl border border-[var(--color-border)]',
          className,
        )}
      >
        {previewSrc !== null && (
          <img
            src={previewSrc}
            alt=""
            width={600}
            height={600}
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover opacity-60 grayscale"
          />
        )}
        <span
          aria-hidden
          className="nft-preview-shimmer-overlay pointer-events-none absolute inset-0"
        />
      </div>
    </>
  );
}
