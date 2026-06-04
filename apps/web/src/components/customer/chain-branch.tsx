'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface ChainBranchEvent {
  readonly id: string;
  readonly label: string;
  readonly contractId?: string;
  readonly tone: 'success' | 'pending' | 'archived';
  readonly subLabel?: string;
}

interface ChainBranchProps {
  readonly events: readonly ChainBranchEvent[];
  readonly chainNetwork?: string | null;
  readonly emptyMessage?: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Truncate an on-chain id (the setCredential / mint tx hash on the FHE
 * build) to first 6 + ellipsis + last 4 hex chars. Full id is preserved
 * as the `title` attribute so a hover reveals it.
 */
function truncateContractId(cid: string): string {
  if (cid.length <= 14) return cid;
  return `${cid.slice(0, 6)}…${cid.slice(-4)}`;
}

/**
 * Build a block-explorer deep link for a mint tx hash. The FHE build
 * stores the `setCredential` tx hash in `chainContractId`, so a chip's
 * id is an EVM tx hash the user can open on the network's explorer.
 *
 * Returns `null` (chip stays non-clickable) when the network is unknown
 * or the id is not a 32-byte tx hash, no hardcoded fallback network so
 * an unexpected value never links to the wrong chain.
 */
const EXPLORER_BASE: Readonly<Record<string, string>> = {
  sepolia: 'https://sepolia.etherscan.io',
  mainnet: 'https://etherscan.io',
};

function explorerTxUrl(
  network: string | null | undefined,
  txHash: string,
): string | null {
  if (network == null) return null;
  const base = EXPLORER_BASE[network];
  if (base === undefined) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  return `${base}/tx/${txHash}`;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Chain event branch, left panel shown next to the verification
 * stepper. Renders blockchain artefacts as chips: Basic credential,
 * Enhanced credential, soulbound NFT mint. Each chip shows the
 * truncated on-chain contract id (full id revealed on hover).
 *
 * The component is purely presentational; the page is responsible for
 * deriving the `events` array from the customer's credential history.
 */
export function ChainBranch({ events, chainNetwork, emptyMessage }: ChainBranchProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
          Chain events
        </h3>
        {chainNetwork === 'mainnet' && (
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
            mainnet
          </span>
        )}
      </div>

      {events.length === 0 ? (
        <p className="text-xs italic text-[var(--color-muted)]">
          {emptyMessage ?? 'No chain events yet. Complete the verification steps to see your on-chain artefacts here.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {events.map((event) => (
            <li key={event.id}>
              <div
                className={cn(
                  'flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                  event.tone === 'success' &&
                    'border-[var(--color-success)]/30 bg-[var(--color-success)]/5',
                  event.tone === 'pending' &&
                    'border-[var(--color-border)] bg-[var(--color-surface)]',
                  event.tone === 'archived' &&
                    'border-[var(--color-border)] bg-[var(--color-surface)] opacity-60',
                )}
              >
                <span
                  className={cn(
                    'truncate text-[var(--color-fg)]',
                    event.tone === 'archived' && 'line-through',
                  )}
                >
                  {event.label}
                </span>
                {event.contractId !== undefined &&
                  (() => {
                    const url = explorerTxUrl(chainNetwork, event.contractId);
                    if (url === null) {
                      return (
                        <code
                          className="shrink-0 font-mono text-[10px] text-[var(--color-muted)]"
                          title={event.contractId}
                        >
                          {truncateContractId(event.contractId)}
                        </code>
                      );
                    }
                    return (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`View on explorer: ${event.contractId}`}
                        className="shrink-0 cursor-pointer font-mono text-[10px] text-[var(--color-muted)] underline decoration-dotted underline-offset-2 transition-colors hover:text-[var(--color-fg)]"
                      >
                        {truncateContractId(event.contractId)}
                      </a>
                    );
                  })()}
              </div>
              {event.subLabel !== undefined && (
                <p className="mt-1 pl-2.5 text-[10px] text-[var(--color-muted)]">
                  {event.subLabel}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
