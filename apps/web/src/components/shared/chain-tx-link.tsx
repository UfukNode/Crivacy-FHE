/**
 * Canonical on-chain artefact reference. Renders a transaction hash
 * (truncated) as either:
 *   - an external link to the block explorer (Etherscan) for the row's
 *     network, or
 *   - inert monospace text when the id is not a valid tx hash.
 *
 * Used everywhere a `kyc_credentials_meta` row surfaces, admin
 * customer detail, customer credential page, dashboard B2B viewer.
 * Routing the URL through `explorerTxUrl` keeps the network → base
 * mapping in one place; no caller hand-rolls hrefs.
 *
 * Layout: when a `label` is supplied the component renders **stacked**
 *, uppercase muted caption above an independent value row. Inline
 * `Label: value` is intentionally avoided because mixing prose label
 * with a clickable id reads as cramped and is the visual style the
 * design review flagged on the admin customer detail page.
 */

import * as React from 'react';
import { ExternalLink } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Etherscan tx URL for the CrivacyKYC on-chain layer (Sepolia). Returns null
 * when the id is not a 32-byte tx hash (the chip then renders inert).
 */
function explorerTxUrl(txHash: string | null, network: string | null): string | null {
  if (txHash === null || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  const base = network === 'mainnet' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io';
  return `${base}/tx/${txHash}`;
}

/** Truncate a long id (tx hash / address) for display: `0x1234abcd…deadbeef`. */
function truncateId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 10)}…${id.slice(-8)}`;
}

export interface ChainTxLinkProps {
  /**
   * On-chain transaction hash (`0x…`, 32 bytes). When present the chip
   * becomes a clickable link to the explorer's transaction page. Fallback
   * identifier is shown if `displayId` is provided.
   */
  readonly updateId: string | null;
  /**
   * Bare contract id / reference used purely for visual fallback when
   * `updateId` is null, the chip stays inert but still shows a
   * recognisable id so admins can copy/paste it. When omitted AND
   * `updateId` is null, the component renders `null`.
   */
  readonly displayId?: string | null;
  readonly network?: string | null;
  /**
   * Optional uppercase block-level caption. When provided the
   * component renders a stacked `<caption>/<value>` pair; when
   * omitted only the value row is rendered (caller controls
   * surrounding layout).
   */
  readonly label?: string;
  readonly className?: string;
}

/**
 * Visually identical link-shaped chip used in both clickable and
 * inert states, when the id is a valid tx hash the chip is a real
 * anchor to the explorer; otherwise the same chip renders as a styled
 * `<span>` so the layout stays consistent. Backfilling the tx hash
 * only flips the underlying element type without any cosmetic shift.
 */
function ChainTxValue({
  shownId,
  updateId,
  network,
  fullTitle,
}: {
  readonly shownId: string;
  readonly updateId: string | null;
  readonly network: string | null;
  readonly fullTitle: string;
}) {
  const url = explorerTxUrl(updateId, network);
  const sharedClass =
    'inline-flex items-center gap-1 font-mono text-xs text-[var(--color-accent)]';

  if (url === null) {
    return (
      <span
        className={cn(sharedClass, 'cursor-default')}
        title={fullTitle}
        aria-disabled="true"
      >
        <span>{shownId}</span>
        <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(sharedClass, 'hover:underline')}
      title={fullTitle}
    >
      <span>{shownId}</span>
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );
}

export function ChainTxLink({
  updateId,
  displayId,
  network,
  label,
  className,
}: ChainTxLinkProps) {
  // Pick the id to render. Prefer the tx hash (the one the link
  // resolves) so the visible chip matches what the explorer
  // actually serves; fall back to the contract id when the row
  // pre-dates the column or its mint hasn't returned yet.
  const renderableId = updateId ?? displayId ?? null;
  if (renderableId === null || renderableId.length === 0) return null;
  const truncated = truncateId(renderableId);
  const fullTitle = updateId ?? displayId ?? '';
  const value = (
    <ChainTxValue
      shownId={truncated}
      updateId={updateId}
      network={network ?? null}
      fullTitle={fullTitle}
    />
  );

  if (label === undefined) {
    return <span className={className}>{value}</span>;
  }

  return (
    <div className={cn('space-y-0.5', className)}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </div>
      <div>{value}</div>
    </div>
  );
}
