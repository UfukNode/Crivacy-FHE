/**
 * Independent on-chain check button + result panel.
 *
 * Hits `/api/fhe-verify`, which reads the `CrivacyKYC` contract on
 * the configured Sepolia RPC directly (a plain on-chain read;
 * Crivacy's servers are not in the loop). The result is the firm's own
 * verdict on whether the credential referenced by the OAuth claims is
 * still active on Sepolia. The "without trusting Crivacy" framing is the whole
 * point of the panel — it demonstrates the non-custodial property of
 * Crivacy credentials: the on-chain artefact is the source of truth,
 * Crivacy is just the gateway that helps you obtain a reference to
 * it.
 */

'use client';

import { useState } from 'react';
import { ChevronRight, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';

/** Firm-decrypted eligibility verdict (or its non-decrypted state). */
type EligibilitySummary =
  | { readonly status: 'granted'; readonly eligible: boolean }
  | { readonly status: 'pending' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'unconfigured' };

interface ActiveVerdict {
  readonly kind: 'active';
  readonly status: string;
  readonly validator: string | null;
  readonly validUntil: string | null;
  readonly issuedAt: string | null;
  readonly network: string | null;
  readonly observedAt: string;
  readonly contractShort: string;
  readonly userRefHashShort: string;
  readonly proofHashShort: string;
  readonly eligibility: EligibilitySummary;
}

interface RevokedVerdict {
  readonly kind: 'revoked';
  readonly status: string;
  readonly network: string | null;
  readonly observedAt: string;
  readonly contractShort: string;
}

interface ErrorVerdict {
  readonly kind: 'error';
  readonly code: string;
  readonly message: string;
}

type Verdict = ActiveVerdict | RevokedVerdict | ErrorVerdict;

function truncateMiddle(value: string, head: number, tail: number): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatDate(iso: string | null): string {
  if (iso === null) return '-';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const deltaSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (deltaSec < 5) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)}m ago`;
  return new Date(then).toLocaleString();
}

function parseEligibility(raw: unknown): EligibilitySummary {
  if (typeof raw !== 'object' || raw === null) return { status: 'unconfigured' };
  const status = (raw as Record<string, unknown>)['status'];
  if (status === 'granted') {
    return { status: 'granted', eligible: (raw as Record<string, unknown>)['eligible'] === true };
  }
  if (status === 'pending') return { status: 'pending' };
  if (status === 'unavailable') return { status: 'unavailable' };
  return { status: 'unconfigured' };
}

export function IndependentFheCheck() {
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);

  async function run(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/fhe-verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const code = typeof body['error'] === 'string' ? (body['error'] as string) : 'unknown';
        const message =
          typeof body['message'] === 'string'
            ? (body['message'] as string)
            : `On-chain read failed (HTTP ${res.status}).`;
        setVerdict({ kind: 'error', code, message });
        return;
      }
      // The FHE route returns the on-chain `CredentialView` under `view`.
      // Only the plaintext lifecycle is readable here; the sensitive fields
      // (level, scores, verification flags) stay as FHE ciphertext handles.
      const view = (body['view'] ?? {}) as Record<string, unknown>;
      const contract = typeof body['contract'] === 'string' ? (body['contract'] as string) : '';
      const network = typeof body['network'] === 'string' ? (body['network'] as string) : null;
      const observedAt =
        typeof body['observedAt'] === 'string' ? (body['observedAt'] as string) : new Date().toISOString();
      const status = typeof view['status'] === 'string' ? (view['status'] as string) : 'unknown';
      const contractShort = truncateMiddle(contract, 10, 8);
      const isActive = view['isActive'] === true;
      if (!isActive) {
        setVerdict({ kind: 'revoked', status, network, observedAt, contractShort });
      } else {
        const validator = typeof view['validator'] === 'string' ? (view['validator'] as string) : null;
        const validUntil = typeof view['validUntil'] === 'string' ? (view['validUntil'] as string) : null;
        const issuedAt = typeof view['issuedAt'] === 'string' ? (view['issuedAt'] as string) : null;
        const userRefHash = typeof view['userRefHash'] === 'string' ? (view['userRefHash'] as string) : '';
        const proofHash = typeof view['proofHash'] === 'string' ? (view['proofHash'] as string) : '';
        setVerdict({
          kind: 'active',
          status,
          validator,
          validUntil,
          issuedAt,
          network,
          observedAt,
          contractShort,
          userRefHashShort: truncateMiddle(userRefHash, 10, 8),
          proofHashShort: truncateMiddle(proofHash, 10, 8),
          eligibility: parseEligibility(body['eligibility']),
        });
      }
    } catch (err) {
      setVerdict({
        kind: 'error',
        code: 'network_error',
        message: (err as Error).message || 'Network call failed.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-md border border-stone-700 bg-stone-900/60 px-3.5 py-2 text-[13px] font-medium text-stone-100 transition-colors hover:border-stone-600 hover:bg-stone-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" strokeWidth={1.75} />
            <span>Querying the chain…</span>
          </>
        ) : (
          <>
            <ShieldCheck className="h-3.5 w-3.5 text-[#cc785c]" aria-hidden="true" strokeWidth={1.75} />
            <span>Verify on Sepolia (without Crivacy)</span>
            <ChevronRight className="h-3.5 w-3.5 text-stone-500" aria-hidden="true" strokeWidth={1.75} />
          </>
        )}
      </button>

      {verdict !== null ? <VerdictPanel verdict={verdict} /> : null}
    </div>
  );
}

function VerdictPanel({ verdict }: { readonly verdict: Verdict }) {
  if (verdict.kind === 'error') {
    return (
      <div
        role="status"
        className="rounded-lg border border-stone-800 bg-stone-900/40 px-4 py-3 text-[13px] text-stone-300"
      >
        <div className="flex items-start gap-2">
          <ShieldQuestion
            className="mt-0.5 h-4 w-4 shrink-0 text-stone-500"
            aria-hidden="true"
            strokeWidth={1.75}
          />
          <div>
            <p className="font-medium text-stone-100">Could not reach the chain</p>
            <p className="mt-1 text-[12px] text-stone-400">{verdict.message}</p>
            <p className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-600">
              error.{verdict.code}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (verdict.kind === 'revoked') {
    return (
      <div
        role="status"
        className="rounded-lg border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-[13px] text-rose-200"
      >
        <div className="flex items-start gap-2">
          <ShieldAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-rose-400"
            aria-hidden="true"
            strokeWidth={1.75}
          />
          <div className="min-w-0">
            <p className="font-medium text-rose-100">Credential is no longer active on chain</p>
            <p className="mt-1 text-[12px] text-rose-300/90">
              The on-chain credential is <span className="font-mono">{verdict.status}</span>,
              revoked or expired since the OAuth grant. Treat the verified state as revoked, even
              if Crivacy still claims it.
            </p>
            <dl className="mt-3 space-y-1 font-mono text-[11px] text-rose-300/80">
              <Row label="contract" value={verdict.contractShort} />
              <Row label="status" value={verdict.status} />
              <Row label="network" value={verdict.network ?? '-'} />
              <Row label="observed" value={formatRelative(verdict.observedAt)} />
            </dl>
          </div>
        </div>
      </div>
    );
  }

  // active
  return (
    <div
      role="status"
      className="rounded-lg border border-[#cc785c]/30 bg-[#cc785c]/5 px-4 py-3 text-[13px] text-stone-200"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck
          className="mt-0.5 h-4 w-4 shrink-0 text-[#cc785c]"
          aria-hidden="true"
          strokeWidth={1.75}
        />
        <div className="min-w-0">
          <p className="font-medium text-stone-50">Verified independently on Sepolia</p>
          <p className="mt-1 text-[12px] text-stone-400">
            Our Sepolia client read the credential straight from the CrivacyKYC
            contract. Crivacy is not in the trust loop.
          </p>
          <dl className="mt-3 space-y-1 font-mono text-[11px] text-stone-400">
            <Row label="contract" value={verdict.contractShort} />
            <Row label="status" value={verdict.status} valueClass="text-emerald-300" />
            <Row label="validator" value={verdict.validator ?? '-'} />
            <Row label="user ref hash" value={verdict.userRefHashShort} />
            <Row label="proof hash" value={verdict.proofHashShort} />
            <Row label="issued" value={formatDate(verdict.issuedAt)} />
            <Row label="valid until" value={formatDate(verdict.validUntil)} />
            <Row label="network" value={verdict.network ?? '-'} />
            <Row label="observed" value={formatRelative(verdict.observedAt)} />
          </dl>
          <EligibilityBlock eligibility={verdict.eligibility} />
        </div>
      </div>
    </div>
  );
}

function EligibilityBlock({ eligibility }: { readonly eligibility: EligibilitySummary }) {
  if (eligibility.status === 'granted') {
    const ok = eligibility.eligible;
    return (
      <div
        className={`mt-4 rounded-md border px-3 py-2.5 ${
          ok
            ? 'border-emerald-800/60 bg-emerald-950/30'
            : 'border-amber-800/60 bg-amber-950/30'
        }`}
      >
        <div className="flex items-center gap-2">
          {ok ? (
            <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden="true" strokeWidth={1.75} />
          ) : (
            <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden="true" strokeWidth={1.75} />
          )}
          <p className={`text-[13px] font-medium ${ok ? 'text-emerald-100' : 'text-amber-100'}`}>
            {ok ? 'Eligible' : 'Not eligible'}
            <span className="ml-1.5 font-normal opacity-80">
              (decrypted from FHE ciphertext via the Zama relayer)
            </span>
          </p>
        </div>
        <p className="mt-1.5 text-[11.5px] text-stone-400">
          We decrypted only this one boolean verdict with our own key. Level, human score and the
          verification flags stay encrypted on chain — we never see them, and neither does anyone else.
        </p>
      </div>
    );
  }

  if (eligibility.status === 'pending') {
    return (
      <div className="mt-4 rounded-md border border-stone-800 bg-stone-900/40 px-3 py-2.5">
        <p className="text-[13px] font-medium text-stone-200">Eligibility grant landing on chain</p>
        <p className="mt-1 text-[11.5px] text-stone-400">
          Crivacy granted this firm access when you consented; the FHE verdict decrypts once that
          per-user grant tx is mined. Re-run the check in a moment.
        </p>
      </div>
    );
  }

  if (eligibility.status === 'unavailable') {
    return (
      <p className="mt-3 text-[12px] text-stone-400">
        Encrypted level, score and flags stay on chain. The eligibility decrypt is momentarily
        unavailable (relayer); the plaintext lifecycle above is authoritative meanwhile.
      </p>
    );
  }

  // unconfigured — this firm hasn't wired a decrypt key.
  return (
    <p className="mt-3 text-[12px] text-stone-400">
      Level, human score and verification flags are stored as FHE ciphertext on chain, unreadable
      here. A firm granted per-firm access by Crivacy decrypts only the boolean eligibility verdict
      via the Zama relayer.
    </p>
  );
}

function Row({
  label,
  value,
  valueClass,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-stone-600">{label}</dt>
      <dd className={valueClass !== undefined ? valueClass : 'text-stone-200'}>{value}</dd>
    </div>
  );
}
