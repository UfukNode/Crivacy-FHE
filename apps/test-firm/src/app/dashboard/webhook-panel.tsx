/**
 * Webhook panel — polls the TestFirm in-memory webhook log every
 * few seconds and renders what Crivacy has delivered.
 *
 * A client component because we want live updates without a full
 * page reload. Polling (not SSE) is the simplest honest integration
 * for a dev harness: matches what a real consumer would build on
 * first cut.
 */

'use client';

import { useEffect, useState } from 'react';

import { MethodPath } from '../ui/method-path';

interface WebhookEntry {
  readonly id: string;
  readonly receivedAt: string;
  readonly eventType: string;
  readonly eventId: string | null;
  readonly deliveryId: string | null;
  readonly signatureValid: boolean;
  readonly payload: unknown;
}

const POLL_INTERVAL_MS = 3000;

async function fetchEntries(): Promise<WebhookEntry[]> {
  const res = await fetch('/api/webhook-events', {
    cache: 'no-store',
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { entries: WebhookEntry[] };
  return body.entries;
}

export function WebhookPanel() {
  const [entries, setEntries] = useState<WebhookEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await fetchEntries();
        if (!cancelled) {
          setEntries(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void tick();
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  return (
    <section className="overflow-hidden rounded-2xl border border-stone-800 bg-stone-900/30">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-800/80 bg-stone-950/40 px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
              Incoming webhooks
            </p>
            <span aria-hidden className="text-stone-700">·</span>
            <MethodPath method="POST" path="/api/webhooks/crivacy" />
          </div>
          <p className="mt-2 max-w-2xl text-[12.5px] leading-[1.7] text-stone-400">
            Session state and credential lifecycle events delivered by Crivacy. Signed
            with HMAC SHA 256; bad signatures are rejected upstream and never reach this
            panel.
          </p>
        </div>
        <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
          polling {POLL_INTERVAL_MS / 1000}s
        </span>
      </header>

      {error !== null ? (
        <div className="border-b border-stone-800/80 bg-rose-950/30 px-5 py-3 font-mono text-[11.5px] text-rose-300 sm:px-6">
          {error}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div className="px-5 py-10 text-center text-[13px] leading-[1.7] text-stone-500 sm:px-6">
          No webhook events received yet. Trigger one from Crivacy (for example by
          creating a session and completing KYC), or register an endpoint in the Crivacy
          dashboard pointing to the path above.
        </div>
      ) : (
        <ul className="divide-y divide-stone-800">
          {entries.map((entry) => (
            <li key={entry.id} className="px-5 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      entry.signatureValid ? 'bg-[#cc785c]' : 'bg-rose-500'
                    }`}
                    title={entry.signatureValid ? 'HMAC verified' : 'HMAC failed'}
                  />
                  <code className="text-xs font-medium text-stone-100">{entry.eventType}</code>
                  {entry.eventId !== null ? (
                    <span className="text-[11px] text-stone-500">
                      id: <code>{entry.eventId}</code>
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <time className="text-[11px] text-stone-500">
                    {new Date(entry.receivedAt).toLocaleTimeString()}
                  </time>
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedId((prev) => (prev === entry.id ? null : entry.id))
                    }
                    className="text-[11px] text-stone-500 underline decoration-dotted hover:text-stone-100"
                  >
                    {expandedId === entry.id ? 'hide' : 'payload'}
                  </button>
                </div>
              </div>
              {expandedId === entry.id ? (
                <pre className="mt-2 overflow-x-auto rounded bg-stone-950 p-3 font-mono text-[11px] text-stone-200">
                  {JSON.stringify(entry.payload, null, 2)}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
