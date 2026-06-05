'use client';

import * as React from 'react';
import { Check, Eye } from 'lucide-react';
import { toast } from 'sonner';
import Tilt from 'react-parallax-tilt';

import { LoadingButton } from '@/components/shared/loading-button';
import { NftLightbox } from '@/components/customer/nft-lightbox';
import { cn } from '@/lib/utils';

type Theme = 'light' | 'dark';

const PLACEHOLDER_VALUES = {
  CUSTOMER_NO: 'PREVIEW-MINT',
  SERIAL: 'crv-pending',
  ISSUED_AT: 'YYYY-MM-DD',
  PARTY_ID: '0x0000…0000',
} as const;

interface NftThemePickerProps {
  /**
   * Whether the customer is eligible to mint right now. False until
   * the Enhanced credential has landed on chain (kyc_4). When false
   * the previews still render so the customer can browse and pick a
   * theme during the earlier steps, but the Mint button is disabled
   * and the helper copy below explains the gate.
   */
  readonly canMint: boolean;
  /**
   * Called after a successful mint so the parent can revalidate KYC
   * status (SWR mutate). The component does not navigate or unmount
   * itself; the parent decides what UI replaces the picker once the
   * NFT is minted (typically the showcase + minted-link description).
   */
  readonly onMintSuccess: () => void;
}

/**
 * Pre-mint theme picker for the soulbound KYC NFT. Renders both
 * variants (light + dark) side by side as live SVG previews and lets
 * the customer pick before committing the chain submission. The
 * chosen theme is a build-time parameter only, never persisted in
 * the DB; the actual SVG bytes are written immutably onto chain in
 * `KycNFT.image` at mint time, so the chain itself is the source of
 * truth thereafter.
 *
 * Pre-mint preview values:
 *   - `{{CUSTOMER_NO}}` / `{{SERIAL}}` / `{{ISSUED_AT}}` / `{{PARTY_ID}}`
 *     are filled with safe placeholders for the visual cue. The
 *     server fills the real values from authoritative sources at mint
 *     time (`buildEnhancedNftDataUri`); the customer never has the
 *     ability to override them.
 *
 * Visible only when:
 *   - the customer has reached `kyc_4` (Enhanced credential on chain), and
 *   - no NFT has been minted yet (`nftContractId === null`).
 *
 * Outside of those conditions the parent renders a different surface
 * (locked-state shimmer, or the minted showcase).
 */
export function NftThemePicker({ canMint, onMintSuccess }: NftThemePickerProps) {
  const [selected, setSelected] = React.useState<Theme>('dark');
  const [minting, setMinting] = React.useState(false);
  const [previews, setPreviews] = React.useState<Record<Theme, string | null>>({
    light: null,
    dark: null,
  });
  const [zoomTheme, setZoomTheme] = React.useState<Theme | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [lightRes, darkRes] = await Promise.all([
          fetch('/static/nft/enhanced-light.svg', { credentials: 'omit' }),
          fetch('/static/nft/enhanced.svg', { credentials: 'omit' }),
        ]);
        if (!lightRes.ok || !darkRes.ok) return;
        const [lightRaw, darkRaw] = await Promise.all([lightRes.text(), darkRes.text()]);
        const fill = (raw: string): string =>
          raw
            .replace(/\{\{CUSTOMER_NO\}\}/g, PLACEHOLDER_VALUES.CUSTOMER_NO)
            .replace(/\{\{SERIAL\}\}/g, PLACEHOLDER_VALUES.SERIAL)
            .replace(/\{\{ISSUED_AT\}\}/g, PLACEHOLDER_VALUES.ISSUED_AT)
            .replace(/\{\{PARTY_ID\}\}/g, PLACEHOLDER_VALUES.PARTY_ID);
        if (cancelled) return;
        setPreviews({
          light: `data:image/svg+xml;utf8,${encodeURIComponent(fill(lightRaw))}`,
          dark: `data:image/svg+xml;utf8,${encodeURIComponent(fill(darkRaw))}`,
        });
      } catch {
        // Silent fall-through, cards stay blank with shimmer.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleMint = React.useCallback(async () => {
    if (!canMint) {
      toast.error('Complete address verification first to mint your NFT.');
      return;
    }
    setMinting(true);
    try {
      const res = await fetch('/api/customer/credential/mint-nft', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: selected }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        // Special-case the recovery-pending branch so the customer
        // gets actionable copy instead of a generic "failed". The
        // backend hits this path when the chain's tx-deduplication
        // says the mint already landed but the DB never recorded the
        // contract id (mid-handler crash). The reconciler's orphan-
        // NFT pass rehydrates the row within a cycle (~15 min), and
        // the SWR refresh shows the live result.
        if (body?.error?.code === 'nft_mint_pending_recovery') {
          toast.message('Your NFT mint is being finalised. It will appear shortly, refresh in a moment.');
          onMintSuccess();
          return;
        }
        toast.error(body?.error?.message ?? 'Failed to mint NFT.');
        return;
      }
      toast.success('Your Soulbound NFT was minted on Sepolia.');
      onMintSuccess();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setMinting(false);
    }
  }, [canMint, selected, onMintSuccess]);

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-[var(--color-fg)]">
          Choose your theme to mint
        </h4>
        <p className="text-xs text-[var(--color-muted)]">
          Pick a card style. Your selection is written immutably on chain at mint time
          and can only be changed via revoke + remint afterwards.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(['light', 'dark'] as Theme[]).map((theme) => {
          const previewSrc = previews[theme];
          const isSelected = selected === theme;
          return (
            <div
              key={theme}
              className={cn(
                'relative overflow-hidden rounded-xl border-2 transition-colors',
                isSelected
                  ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]/30'
                  : 'border-[var(--color-border)]/50',
              )}
            >
              {/* Tilt + click-to-select. The parallax tilt matches the
                  showcase on /credential so the customer recognises the
                  affordance once their NFT is minted. The whole tile is
                  the selection target; the eye-icon overlay below is the
                  zoom affordance. */}
              <Tilt
                tiltMaxAngleX={6}
                tiltMaxAngleY={8}
                glareEnable
                glareMaxOpacity={0.14}
                glareColor="#9bdcff"
                glarePosition="all"
                glareBorderRadius="12px"
                scale={1.01}
                transitionSpeed={900}
                gyroscope={false}
              >
                <button
                  type="button"
                  onClick={() => setSelected(theme)}
                  disabled={minting}
                  aria-pressed={isSelected}
                  aria-label={`Choose ${theme} theme`}
                  className={cn(
                    'block aspect-[16/10] w-full cursor-pointer bg-transparent',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                  )}
                >
                  {previewSrc !== null ? (
                    <img
                      src={previewSrc}
                      alt={`${theme} variant preview`}
                      className="h-full w-full select-none object-cover"
                      draggable={false}
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="h-full w-full animate-pulse bg-[var(--color-surface)]" />
                  )}
                </button>
              </Tilt>

              {/* Eye icon, opens the shared lightbox. Top-left so it
                  doesn't collide with the selection check (top-right).
                  `stopPropagation` so clicking the eye does not also
                  fire the parent button's select handler. */}
              <button
                type="button"
                aria-label={`Preview ${theme} variant at full size`}
                onClick={(e) => {
                  e.stopPropagation();
                  setZoomTheme(theme);
                }}
                className="absolute left-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
              >
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              </button>

              {isSelected && (
                <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-[var(--color-accent)] p-1 text-white shadow-sm">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                </div>
              )}

              <span
                className={cn(
                  'pointer-events-none absolute bottom-2 left-2 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                  theme === 'light'
                    ? 'bg-white/90 text-stone-900'
                    : 'bg-black/70 text-white',
                )}
              >
                {theme}
              </span>
            </div>
          );
        })}
      </div>

      <NftLightbox
        open={zoomTheme !== null}
        image={zoomTheme !== null ? (previews[zoomTheme] ?? '') : ''}
        alt={zoomTheme !== null ? `${zoomTheme} NFT preview` : ''}
        onClose={() => setZoomTheme(null)}
      />

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--color-muted)]">
          {canMint ? (
            <>
              Selected:{' '}
              <span className="font-medium text-[var(--color-fg)]">{selected}</span>
            </>
          ) : (
            'Complete address verification to unlock minting.'
          )}
        </p>
        <LoadingButton
          onClick={handleMint}
          loading={minting}
          loadingText="Minting"
          animatedDots
          disabled={minting || !canMint}
        >
          {canMint ? 'Mint your Soulbound NFT' : 'Mint locked'}
        </LoadingButton>
      </div>
    </div>
  );
}

/**
 * Re-export for parent code that wants to show a disabled placeholder
 * (e.g. before address verification completes). Currently parents use
 * `<NftPreviewCard>` for the locked state, but having both buttons
 * pre-rendered makes the journey legible, the user sees what's
 * coming.
 */
export function NftThemePickerLockedPreview() {
  return (
    <div className="grid grid-cols-1 gap-3 opacity-60 sm:grid-cols-2">
      {(['light', 'dark'] as Theme[]).map((theme) => (
        <div
          key={theme}
          className="aspect-[16/10] rounded-xl border-2 border-[var(--color-border)]/40 bg-[var(--color-surface)]"
        >
          <div className="flex h-full w-full items-center justify-center">
            <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
              {theme} preview
            </span>
          </div>
        </div>
      ))}
      <div className="col-span-full mt-1 text-center text-xs text-[var(--color-muted)]">
        Theme picker unlocks once your address is verified.
      </div>
    </div>
  );
}

