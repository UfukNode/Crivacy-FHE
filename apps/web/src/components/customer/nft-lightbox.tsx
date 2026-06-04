'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import Tilt from 'react-parallax-tilt';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface NftLightboxProps {
  /** Whether the overlay is open. */
  readonly open: boolean;
  /**
   * Image source to display. Either an inline `data:image/svg+xml;base64,…`
   * URI (the production case, same bytes as on chain) or a regular
   * URL for previews that fetch from `/static/nft/`.
   */
  readonly image: string;
  /** Accessible label for the image. Used as `aria-label` on the dialog. */
  readonly alt: string;
  /** Called when the user dismisses the overlay (X button, backdrop, ESC). */
  readonly onClose: () => void;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Full-screen NFT image viewer. Rendered as a portal-like fixed overlay
 * with a parallax tilt on the artefact, a circular X close button, and
 * ESC + backdrop dismiss.
 *
 * Single source of truth for the "open NFT at full size" affordance.
 * Used by:
 *
 *   - {@link NftShowcase}, minted-NFT showcase on /credential.
 *   - {@link NftThemePicker}, pre-mint theme previews on /kyc step 4.
 *
 * Centralised here so any future change to the zoom UX (different
 * tilt parameters, swap the close icon, add metadata captions, etc.)
 * lands in one place rather than drifting between the two surfaces.
 */
export function NftLightbox({ open, image, alt, onClose }: NftLightboxProps) {
  // ESC closes, only attach the listener while open so we don't
  // hold a global key handler when the lightbox is dismissed.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${alt} - full size`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
    >
      <button
        type="button"
        aria-label="Close zoom"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute right-6 top-6 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <X className="h-5 w-5" />
      </button>
      <div
        onClick={(e) => e.stopPropagation()}
        className="aspect-[1280/800] w-[min(64vw,calc(63vh*1.6),900px)]"
      >
        <Tilt
          tiltMaxAngleX={10}
          tiltMaxAngleY={12}
          glareEnable
          glareMaxOpacity={0.22}
          glareColor="#9bdcff"
          glarePosition="all"
          glareBorderRadius="20px"
          scale={1.02}
          transitionSpeed={1100}
          gyroscope={false}
          className="h-full w-full"
        >
          <img
            src={image}
            alt={alt}
            className="h-full w-full select-none rounded-2xl object-contain shadow-2xl"
            draggable={false}
            referrerPolicy="no-referrer"
          />
        </Tilt>
      </div>
    </div>
  );
}
