'use client';

/**
 * Firm on-chain wallet registration card.
 *
 * The firm connects a browser wallet and signs a SIWE (EIP-4361) message to
 * prove control of an EVM address. That address becomes the target of the
 * per-user gatekeeper `grantAccess` — the firm later decrypts each consenting
 * user's encrypted eligibility verdict with the SAME key, which Crivacy never
 * holds. Proof-of-control is why we sign rather than just accept a typed
 * address: a firm must not be able to bind an address whose key it lacks.
 */

import { useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { createSiweMessage } from 'viem/siwe';
import { getAddress } from 'viem';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingButton } from '@/components/shared/loading-button';
import { Skeleton } from '@/components/ui/skeleton';

interface WalletResponse {
  onchainAddress: string | null;
}

/** Minimal EIP-1193 shape — avoids pulling a wallet-types dependency. */
interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

function getInjectedProvider(): Eip1193Provider | null {
  const eth = (globalThis as { ethereum?: Eip1193Provider }).ethereum;
  return eth ?? null;
}

function truncate(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function FirmWalletConnect({ canUpdate }: { readonly canUpdate: boolean }) {
  const { data, isLoading, mutate } = useSWR<WalletResponse>('/api/internal/firm/wallet');
  const [busy, setBusy] = useState(false);

  async function handleConnect() {
    const provider = getInjectedProvider();
    if (provider === null) {
      toast.error('No browser wallet detected. Install MetaMask (or similar) to connect.');
      return;
    }
    setBusy(true);
    try {
      // 1. Connect + read the selected account.
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      const account = accounts[0];
      if (account === undefined) {
        toast.error('No account selected in the wallet.');
        return;
      }
      const address = getAddress(account);

      // 2. Ask Crivacy for a nonce.
      const chRes = await fetch('/api/internal/firm/wallet/challenge', {
        method: 'POST',
        credentials: 'include',
      });
      if (!chRes.ok) {
        toast.error('Could not start wallet verification.');
        return;
      }
      const { challenge, nonce } = (await chRes.json()) as { challenge: string; nonce: string };

      // 3. Build + sign the SIWE message.
      const message = createSiweMessage({
        address,
        chainId: 11155111,
        domain: window.location.host,
        nonce,
        uri: window.location.origin,
        version: '1',
        statement: "Register this wallet as your firm's Crivacy grant address.",
      });
      const signature = (await provider.request({
        method: 'personal_sign',
        params: [message, address],
      })) as string;

      // 4. Save (server re-verifies the signature + nonce).
      const putRes = await fetch('/api/internal/firm/wallet', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, message, signature }),
      });
      if (!putRes.ok) {
        const body = (await putRes.json().catch(() => ({}))) as Record<string, unknown>;
        const err = body['error'] as Record<string, unknown> | undefined;
        toast.error((err?.['message'] as string) ?? 'Wallet verification failed.');
        return;
      }
      toast.success('Wallet connected. Per-user grants will target this address.');
      void mutate();
    } catch (err) {
      // User rejected the signature, or the wallet threw.
      const message = err instanceof Error ? err.message : 'Wallet connection failed.';
      toast.error(message.includes('rejected') ? 'Signature request was rejected.' : message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    try {
      const res = await fetch('/api/internal/firm/wallet', {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        toast.error('Could not disconnect the wallet.');
        return;
      }
      toast.success('Wallet disconnected. New consents will not grant on-chain access.');
      void mutate();
    } finally {
      setBusy(false);
    }
  }

  const connected = data?.onchainAddress ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">On-chain wallet</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 max-w-xl text-sm text-[var(--color-muted)]">
          When a user verifies with your firm, Crivacy grants this address permission to decrypt
          only that user&apos;s boolean eligibility verdict on chain. The matching key stays on your
          side and never touches Crivacy.
        </p>

        {isLoading ? (
          <Skeleton className="h-10 w-64" />
        ) : connected !== null ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-sm">
              <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
              {truncate(connected)}
            </span>
            {canUpdate ? (
              <LoadingButton variant="outline" loading={busy} onClick={handleDisconnect}>
                Disconnect
              </LoadingButton>
            ) : null}
          </div>
        ) : canUpdate ? (
          <LoadingButton loading={busy} onClick={handleConnect}>
            Connect wallet
          </LoadingButton>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">No wallet connected.</p>
        )}
      </CardContent>
    </Card>
  );
}
