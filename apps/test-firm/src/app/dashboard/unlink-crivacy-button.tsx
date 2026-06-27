/**
 * Unlink Crivacy identity button.
 *
 * Hits `POST /api/unlink-crivacy` which clears the OAuth
 * identity row + the firm-side OAuth cookies. On success the page
 * refreshes so the dashboard renders the not-verified hero card and
 * the user can re-link with a different Crivacy account if desired.
 *
 * Distinct from the dashboard "Disconnect" button (test-firm logout):
 * that ends the firm-side session; this only detaches the Crivacy
 * grant. The firm user stays signed in to their firm account.
 */

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Unlink } from 'lucide-react';

export function UnlinkCrivacyButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    if (busy) return;
    const ok = window.confirm(
      'Unlink your Crivacy identity from this dApp? You can re-link any time by clicking "Verify with Crivacy" again.',
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch('/api/unlink-crivacy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      if (res.ok) {
        // Soft-refresh the dashboard so the server-rendered panel
        // re-fetches identities (now empty) and falls back to the
        // pre-link profile card.
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-md border border-stone-700 bg-stone-900/60 px-3 py-1.5 text-[12px] font-medium text-stone-300 transition-colors hover:border-stone-600 hover:bg-stone-900 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? (
        <>
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" strokeWidth={1.75} />
          <span>Unlinking…</span>
        </>
      ) : (
        <>
          <Unlink className="h-3 w-3" aria-hidden="true" strokeWidth={1.75} />
          <span>Unlink Crivacy</span>
        </>
      )}
    </button>
  );
}
