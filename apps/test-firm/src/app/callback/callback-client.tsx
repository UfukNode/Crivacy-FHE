/**
 * Client-side callback handler.
 *
 * Server renders the page (so it can read env → `oauthClientId`) and
 * mounts this client component, which does the browser-only work:
 *
 *   1. **Validating** — pull `?code` + `?state`, compare against the
 *      sessionStorage-stored state + verifier (CSRF defence).
 *   2. **Exchanging** — POST `{ code, codeVerifier }` to the
 *      TestFirm proxy (`/api/oauth-finish`), which runs
 *      the confidential token exchange with `client_secret`
 *      server-side.
 *   3. **Linking** — server persists the userinfo claims to
 *      `data-store.ts` so the dashboard can render the verified
 *      hero card with the claim grid + on-chain proof.
 *   4. **Verifying on Sepolia** — POST `/api/fhe-verify`,
 *      which uses `@crivacy/js-sdk::verifyDisclosure` to read the
 *      `CrivacyKYC` contract on Sepolia over a plain RPC call and
 *      return the on-chain credential view. This is the
 *      production-honest step a third-party firm runs against
 *      **their own** Sepolia RPC — Crivacy is not in the trust
 *      loop for this check. A failure here aborts the session.
 *
 * Errors route to the dashboard with `?oauth_error=<code>` — the
 * OauthPanel resolves the per-code human copy and renders a clean
 * alert above the verify button so the user can retry in place.
 */

'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check, Loader2, ShieldCheck } from 'lucide-react';

export function CallbackClient({ clientId }: { clientId: string }) {
  return (
    <Suspense fallback={<CallbackHero step="validating" />}>
      <CallbackInner clientId={clientId} />
    </Suspense>
  );
}

type CallbackStep = 'validating' | 'exchanging' | 'linking' | 'verifying' | 'done';

function clearStorage(clientId: string): void {
  try {
    sessionStorage.removeItem(`crivacy.oauth.state.${clientId}`);
    sessionStorage.removeItem(`crivacy.oauth.verifier.${clientId}`);
    sessionStorage.removeItem(`crivacy.oauth.redirect.${clientId}`);
    sessionStorage.removeItem(`crivacy.oauth.nonce.${clientId}`);
  } catch {
    // private-mode browsers — ignore.
  }
  // Expire the recovery cookie (path-scoped to the callback's parent).
  try {
    const here = new URL(window.location.href);
    const cookieScope = '/' + (here.pathname.split('/').filter(Boolean)[0] || '');
    document.cookie =
      'crivacy_oauth_recovery_' +
      encodeURIComponent(clientId) +
      '=; path=' +
      cookieScope +
      '; max-age=0; SameSite=Lax';
  } catch {
    // Cookie clear failure is non-fatal.
  }
}

/**
 * Read the per-client recovery bundle the snippet stashed in a cookie
 * when `authorize()` ran. Used as a fallback when `sessionStorage` is
 * empty (private mode quirks, tab restore, dev hot reload mid-flow).
 * Returns null when no cookie or the cookie's JSON is malformed.
 */
function readRecoveryCookie(
  clientId: string,
): { state: string; verifier: string; nonce: string | null } | null {
  try {
    const cookieName = 'crivacy_oauth_recovery_' + encodeURIComponent(clientId);
    const rows = document.cookie.split(';');
    for (const row of rows) {
      const [rawKey, ...rest] = row.trim().split('=');
      if (rawKey === cookieName) {
        const rawValue = rest.join('=');
        const decoded = decodeURIComponent(rawValue);
        const parsed = JSON.parse(decoded) as {
          state?: unknown;
          verifier?: unknown;
          nonce?: unknown;
        };
        if (typeof parsed.state !== 'string' || typeof parsed.verifier !== 'string') {
          return null;
        }
        return {
          state: parsed.state,
          verifier: parsed.verifier,
          nonce: typeof parsed.nonce === 'string' ? parsed.nonce : null,
        };
      }
    }
  } catch {
    // Malformed cookie or no document — fall through to null.
  }
  return null;
}

function CallbackInner({ clientId }: { clientId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<CallbackStep>('validating');

  useEffect(() => {
    if (params === null) return;
    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');

    const goHome = (errorCode: string) => {
      clearStorage(clientId);
      router.replace(`/dashboard?oauth_error=${encodeURIComponent(errorCode)}`);
    };

    if (oauthError !== null) {
      goHome(oauthError);
      return;
    }
    if (code === null || state === null) {
      goHome('invalid_callback');
      return;
    }

    let storedState: string | null = null;
    let storedVerifier: string | null = null;
    try {
      storedState = sessionStorage.getItem(`crivacy.oauth.state.${clientId}`);
      storedVerifier = sessionStorage.getItem(`crivacy.oauth.verifier.${clientId}`);
    } catch {
      // Storage threw (private mode / quota / extension block). Fall
      // through to the cookie recovery path before giving up.
    }

    // sessionStorage missing or stale → consult the recovery cookie
    // the snippet sets alongside it. Common cause for the fallback:
    // tab restore between click and callback wiped session-scoped
    // storage but cookies survive.
    if (storedState === null || storedVerifier === null) {
      const recovered = readRecoveryCookie(clientId);
      if (recovered !== null) {
        if (storedState === null) storedState = recovered.state;
        if (storedVerifier === null) storedVerifier = recovered.verifier;
      }
    }

    if (storedState === null) {
      goHome('storage_unavailable');
      return;
    }
    if (storedState !== state) {
      goHome('state_mismatch');
      return;
    }
    if (storedVerifier === null) {
      goHome('missing_verifier');
      return;
    }

    void (async () => {
      setStep('exchanging');
      try {
        const res = await fetch('/api/oauth-finish', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, codeVerifier: storedVerifier }),
        });
        clearStorage(clientId);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          const errCode = typeof body.error === 'string' ? body.error : 'token_exchange_failed';
          router.replace(
            `/dashboard?oauth_error=${encodeURIComponent(errCode)}`,
          );
          return;
        }
        setStep('linking');
        // Brief pause so the "Linking" tick is visible before the
        // verify step kicks off. Without it the linking tick reads
        // as instantaneous, hurting the perceived chain-of-trust
        // narrative we're walking the user through.
        await new Promise((resolve) => setTimeout(resolve, 350));

        setStep('verifying');
        const verifyRes = await fetch('/api/fhe-verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        });
        if (!verifyRes.ok) {
          // chain-side or claims-side failure. Surface the
          // server's error code so the dashboard alert says the
          // right thing — `chain_verify_failed`, `user_ref_mismatch`,
          // `disclosure_blob_missing`, etc.
          const body = (await verifyRes.json().catch(() => ({}))) as { error?: string };
          const errCode = typeof body.error === 'string' ? body.error : 'chain_verify_failed';
          router.replace(
            `/dashboard?oauth_error=${encodeURIComponent(errCode)}`,
          );
          return;
        }

        setStep('done');
        router.replace('/dashboard');
      } catch {
        clearStorage(clientId);
        router.replace('/dashboard?oauth_error=network_error');
      }
    })();
  }, [clientId, params, router]);

  return <CallbackHero step={step} />;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

const STEPS: ReadonlyArray<{ id: CallbackStep; label: string; sub: string }> = [
  {
    id: 'validating',
    label: 'Validating',
    sub: 'Checking the sign-in state token.',
  },
  {
    id: 'exchanging',
    label: 'Exchanging',
    sub: 'Trading the auth code for tokens server-side.',
  },
  {
    id: 'linking',
    label: 'Linking',
    sub: 'Persisting the verified identity to TestFirm.',
  },
  {
    id: 'verifying',
    label: 'Verifying on Sepolia',
    sub: 'Submitting the disclosure blob to the chain directly. Crivacy is not in the trust loop.',
  },
];

function stepIndex(step: CallbackStep): number {
  if (step === 'validating') return 0;
  if (step === 'exchanging') return 1;
  if (step === 'linking') return 2;
  if (step === 'verifying') return 3;
  return 4;
}

function CallbackHero({ step }: { readonly step: CallbackStep }) {
  const activeIdx = stepIndex(step);
  const progressPct = Math.min(100, Math.round(((activeIdx + 1) / STEPS.length) * 100));
  return (
    <div className="flex min-h-[calc(100vh-12rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="overflow-hidden rounded-3xl border border-stone-800 bg-stone-900/40 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.5)]">
          <div
            aria-hidden
            className="h-[3px] w-full bg-stone-900"
          >
            <div
              className="h-full bg-gradient-to-r from-[#cc785c] via-[#e8a684] to-[#cc785c] transition-[width] duration-500 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="px-10 pb-10 pt-14 text-center">
            <div
              aria-hidden
              className="relative mx-auto mb-7 flex h-20 w-20 items-center justify-center"
            >
              <span className="absolute inset-0 rounded-full bg-[#cc785c]/12 blur-xl" />
              <span className="absolute inset-1 rounded-full border border-[#cc785c]/30 bg-stone-900/80" />
              <ShieldCheck
                className="relative h-9 w-9 text-[#e8a684]"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-500">
              gateway.callback
            </p>
            <h1 className="mt-3 font-serif text-[28px] font-normal leading-tight tracking-tight text-stone-50 sm:text-[30px]">
              Finishing sign in
            </h1>
            <p
              className="mx-auto mt-3 max-w-md text-[14px] leading-[1.65] text-stone-400"
              aria-live="polite"
            >
              {STEPS[activeIdx]?.sub ?? 'Almost there.'}
            </p>
          </div>
          <ol className="space-y-5 border-t border-stone-800/80 bg-stone-950/40 px-10 py-8">
            {STEPS.map((s, idx) => {
              const state: 'pending' | 'active' | 'done' =
                idx < activeIdx ? 'done' : idx === activeIdx ? 'active' : 'pending';
              return (
                <li key={s.id} className="flex items-start gap-4">
                  <span
                    aria-hidden
                    className={
                      state === 'done'
                        ? 'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#cc785c] text-stone-50 shadow-[0_0_0_4px_rgba(204,120,92,0.12)]'
                        : state === 'active'
                          ? 'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#cc785c]/45 bg-[#cc785c]/12 text-[#e8a684] shadow-[0_0_0_4px_rgba(204,120,92,0.08)]'
                          : 'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-stone-800 bg-stone-900/60 text-stone-600'
                    }
                  >
                    {state === 'done' ? (
                      <Check className="h-4 w-4" strokeWidth={2.5} />
                    ) : state === 'active' ? (
                      <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                    ) : (
                      <span className="font-mono text-[12px] font-medium tabular-nums">
                        {idx + 1}
                      </span>
                    )}
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <p
                      className={
                        state === 'pending'
                          ? 'font-serif text-[16px] font-normal text-stone-600'
                          : state === 'active'
                            ? 'font-serif text-[16px] font-normal text-stone-50'
                            : 'font-serif text-[16px] font-normal text-stone-200'
                      }
                    >
                      {s.label}
                    </p>
                    <p
                      className={
                        state === 'pending'
                          ? 'mt-0.5 text-[12.5px] leading-[1.5] text-stone-700'
                          : 'mt-0.5 text-[12.5px] leading-[1.5] text-stone-500'
                      }
                    >
                      {s.sub}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
        <p className="mt-5 text-center font-mono text-[10.5px] uppercase tracking-[0.16em] text-stone-600">
          Secure round-trip · Crivacy gateway → Northwind Finance
        </p>
      </div>
    </div>
  );
}
