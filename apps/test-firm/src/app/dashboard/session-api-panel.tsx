/**
 * Session API panel (client component).
 *
 * Form that exercises `POST /api/v1/sessions` via TestFirm's server
 * proxy (`/api/session`). The proxy owns the firm's API
 * key — the browser only sees the request payload and the relayed
 * response body + headers.
 *
 * We surface the `x-ratelimit-*` / `x-quota-*` / `retry-after`
 * headers alongside the body so a developer can see the firm-keyed
 * throttling behaviour and confirm the wiring is live.
 */

'use client';

import { useState } from 'react';

import { MethodPath } from '../ui/method-path';

interface ApiView {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface SavedSession {
  readonly id: string;
  readonly userRef: string;
  readonly workflow: string;
  readonly level: string;
  readonly verificationUrl: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly lastStatusUpdateAt: string;
}

interface Props {
  readonly defaultUserRef: string;
  readonly savedSessions: readonly SavedSession[];
}

const RATE_HEADER_PREFIXES = ['x-ratelimit', 'x-quota', 'retry-after', 'x-request-id'];

async function callSessionProxy(payload: unknown): Promise<ApiView> {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (RATE_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      headers[lower] = v;
    }
  });
  return { status: res.status, headers, body };
}

function statusBadgeColor(status: string): string {
  if (status === 'approved') return 'bg-[#cc785c]/15 text-[#e8a684]';
  if (status === 'declined' || status === 'expired') return 'bg-rose-950/60 text-rose-300';
  if (status === 'in_progress') return 'bg-amber-950/60 text-amber-300';
  return 'bg-stone-800 text-stone-300';
}

export function SessionApiPanel({ defaultUserRef, savedSessions }: Props) {
  const [userRef, setUserRef] = useState(defaultUserRef);
  const [workflow, setWorkflow] = useState<'full' | 'identity' | 'address'>('full');
  const [level, setLevel] = useState<'basic' | 'enhanced'>('basic');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ApiView | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const result = await callSessionProxy({ userRef, workflow, level });
      setView(result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-stone-800 bg-stone-900/30">
      <header className="border-b border-stone-800/80 bg-stone-950/40 px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
            Start a new KYC
          </p>
          <span aria-hidden className="text-stone-700">·</span>
          <MethodPath method="POST" path="/api/v1/sessions" />
        </div>
        <p className="mt-2 max-w-2xl text-[12.5px] leading-[1.7] text-stone-400">
          Routed through the Northwind server proxy so the firm API key never
          touches the browser. End users do not need a Crivacy account; they complete
          KYC on Didit through the returned verification URL.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-5 px-5 py-5 sm:px-6 sm:py-6">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1.5">
            <span className="block font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
              userRef
            </span>
            <input
              value={userRef}
              onChange={(e) => setUserRef(e.target.value)}
              className="block w-full rounded-md border border-stone-700 bg-stone-950/60 px-2.5 py-2 font-mono text-xs text-stone-100 placeholder:text-stone-600 focus:border-[#cc785c] focus:outline-none focus:ring-1 focus:ring-[#cc785c]/60"
              required
            />
          </label>
          <label className="space-y-1.5">
            <span className="block font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
              workflow
            </span>
            <select
              value={workflow}
              onChange={(e) => setWorkflow(e.target.value as typeof workflow)}
              className="block w-full rounded-md border border-stone-700 bg-stone-950/60 px-2.5 py-2 text-xs text-stone-100 focus:border-[#cc785c] focus:outline-none focus:ring-1 focus:ring-[#cc785c]/60"
            >
              <option value="full">full</option>
              <option value="identity">identity</option>
              <option value="address">address</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="block font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
              level
            </span>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value as typeof level)}
              className="block w-full rounded-md border border-stone-700 bg-stone-950/60 px-2.5 py-2 text-xs text-stone-100 focus:border-[#cc785c] focus:outline-none focus:ring-1 focus:ring-[#cc785c]/60"
            >
              <option value="basic">basic</option>
              <option value="enhanced">enhanced</option>
            </select>
          </label>
        </div>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md bg-[#cc785c] px-4 py-2 text-[13px] font-medium text-stone-50 transition-colors hover:bg-[#b86a52] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Creating session…' : 'Create KYC session'}
        </button>
      </form>

      {view !== null ? (
        <div className="border-t border-stone-800/80">
          <div className="flex items-center justify-between gap-3 bg-stone-950/40 px-5 py-3 sm:px-6">
            <MethodPath method="POST" path="/api/v1/sessions" />
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium ${
                view.status >= 200 && view.status < 300
                  ? 'border-emerald-900/60 bg-emerald-950/40 text-emerald-300'
                  : view.status >= 400
                    ? 'border-rose-900/60 bg-rose-950/40 text-rose-300'
                    : 'border-stone-700 bg-stone-900/60 text-stone-300'
              }`}
            >
              HTTP {view.status}
            </span>
          </div>
          {Object.keys(view.headers).length > 0 ? (
            <dl className="divide-y divide-stone-800/80 border-t border-stone-800/80 bg-stone-950/60 px-5 py-2 text-xs sm:px-6">
              {Object.entries(view.headers).map(([k, v]) => (
                <div key={k} className="flex justify-between py-1.5">
                  <dt className="font-mono text-stone-500">{k}</dt>
                  <dd className="font-mono text-stone-200">{v}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <pre className="overflow-x-auto border-t border-stone-800/80 bg-stone-950 px-5 py-3.5 font-mono text-xs leading-[1.7] text-stone-200 sm:px-6">
            {view.body || '(empty body)'}
          </pre>
        </div>
      ) : null}

      {savedSessions.length > 0 ? (
        <div className="border-t border-stone-800/80 bg-stone-950/40">
          <div className="px-5 py-3.5 sm:px-6">
            <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
              Saved sessions for this user
            </p>
            <p className="mt-1 text-[12px] text-stone-500">
              Persisted from the Crivacy create response and webhook status updates.
            </p>
          </div>
          <ul className="divide-y divide-stone-800/60 border-t border-stone-800/80">
            {savedSessions.map((session) => (
              <li key={session.id} className="px-5 py-3.5 sm:px-6">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <code className="truncate font-mono text-[12px] text-stone-200">
                      {session.id}
                    </code>
                    <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-stone-500">
                      {session.workflow} · {session.level}
                    </span>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[11px] font-medium ${statusBadgeColor(session.status)}`}
                  >
                    {session.status}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-stone-500">
                  <span>
                    created {new Date(session.createdAt).toLocaleString()}
                    {session.lastStatusUpdateAt !== session.createdAt
                      ? ` · updated ${new Date(session.lastStatusUpdateAt).toLocaleString()}`
                      : ''}
                  </span>
                  {session.verificationUrl !== null ? (
                    <a
                      href={session.verificationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#cc785c] underline decoration-dotted hover:text-[#e8a684]"
                    >
                      verification URL ↗
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
