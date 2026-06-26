/**
 * OAuth panel — production-realistic firm dashboard view.
 *
 * Three states, each modelled on what a real firm consuming Crivacy
 * would show its users:
 *
 *   1. **Pre-link profile** (no `OauthIdentityRecord` yet) — renders
 *      the firm user's current account state: avatar initials,
 *      display name, deterministic placeholder user address,
 *      "Not Verified" pill, "Level: —". A clear CTA invites the
 *      user to authorise verification. This mirrors the Binance /
 *      Coinbase pattern: signed in but not yet KYC-verified.
 *
 *   2. **Verified profile** — the OAuth grant is in place. The card
 *      shows the user's verification status, on-chain proof, scopes,
 *      privacy posture, and exposes two firm-side actions:
 *        a. *Independent Sepolia check* — runs a Sepolia read from
 *           the firm's own server (no Crivacy library used), so the
 *           firm doesn't have to take Crivacy's word for it.
 *        b. *Unlink Crivacy* — detaches the OAuth grant; the firm
 *           user can re-link with a different Crivacy account, or
 *           operate without one.
 *
 *   3. **Verified-but-revoked / verified-but-expired** — the
 *      verified card with a warning banner. Driven off the
 *      `revokedAt` / `expiredAt` lifecycle fields populated by
 *      webhook events. Re-running OAuth resets to state 2.
 *
 * The error toast on top renders an `?oauth_error=<code>` param from
 * the callback page.
 */

import {
  ArrowUpRight,
  BadgeCheck,
  Clock,
  Hash,
  Layers,
  Lock,
  MapPin,
  RefreshCw,
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';

import { loadTestFirmConfig } from '../config';
import { TEST_FIRM_SCOPES } from '../config';
import type { OauthIdentityRecord } from '../data-store';
import {
  deriveAvatarInitials,
  deriveDisplayName,
} from '../identity-placeholder';
import { CrivacyVerifyButton } from './crivacy-verify-button';
import { IndependentFheCheck } from './independent-fhe-check';
import { UnlinkCrivacyButton } from './unlink-crivacy-button';

interface OauthPanelProps {
  readonly savedIdentity: OauthIdentityRecord | null;
  readonly errorCode: string | null;
  readonly firmUser: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string | null;
  };
}

const ERROR_COPY: Readonly<Record<string, { title: string; body: string }>> = {
  access_denied: {
    title: 'Verification cancelled',
    body: 'You can try again anytime.',
  },
  state_mismatch: {
    title: 'Sign in session expired',
    body: 'The link aged out mid flow. Start over to get a fresh one.',
  },
  missing_verifier: {
    title: 'Browser lost the sign in state',
    body: 'Private mode or a cleared tab dropped the PKCE verifier. Try again in this tab.',
  },
  invalid_callback: {
    title: 'Sign in link incomplete',
    body: 'Your browser did not return with a valid code. Start over.',
  },
  token_exchange_failed: {
    title: 'Could not complete sign in',
    body: 'Token exchange with the gateway failed. Check your connection and try again.',
  },
  token_network_error: {
    title: 'Network blocked the token exchange',
    body: 'Could not reach the gateway. Retry, or check if a proxy is intercepting requests.',
  },
  token_parse_failed: {
    title: 'Gateway returned an unreadable response',
    body: 'Usually transient. Try again. If it persists, refresh the page.',
  },
  token_shape_invalid: {
    title: 'Gateway returned an unexpected payload',
    body: 'Try again. If the issue persists, contact support.',
  },
  network_error: {
    title: 'Network dropped during sign in',
    body: 'The connection was lost mid flow. Try again.',
  },
  storage_unavailable: {
    title: 'Browser storage is disabled',
    body: 'sessionStorage is required. Disable private mode or enable storage for this site.',
  },
  unauthenticated: {
    title: 'dApp session stale',
    body: 'Sign out and back in, then retry verification.',
  },
};

function resolveErrorCopy(code: string): { title: string; body: string } {
  return (
    ERROR_COPY[code] ?? {
      title: 'Sign in did not complete',
      body: `Something went wrong (${code}). Try again.`,
    }
  );
}

export function OauthPanel({ savedIdentity, errorCode, firmUser }: OauthPanelProps) {
  const cfg = loadTestFirmConfig();
  const scopeString = TEST_FIRM_SCOPES.join(' ');
  const errorCopy = errorCode !== null ? resolveErrorCopy(errorCode) : null;

  return (
    <section aria-label="Crivacy identity">
      {errorCopy !== null ? (
        <div
          role="alert"
          className="mb-5 flex items-start gap-3 rounded-lg border border-stone-800 bg-stone-900/40 px-4 py-3 text-sm"
        >
          <TriangleAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-[#cc785c]"
            aria-hidden="true"
            strokeWidth={1.75}
          />
          <div>
            <p className="font-medium text-stone-100">{errorCopy.title}</p>
            <p className="mt-1 text-[13px] text-stone-400">{errorCopy.body}</p>
          </div>
        </div>
      ) : null}

      {savedIdentity === null ? (
        <PreLinkProfileCard
          firmUser={firmUser}
          clientId={cfg.oauthClientId}
          redirectUri={cfg.redirectUri}
          scope={scopeString}
          issuer={cfg.apiBaseUrl}
        />
      ) : (
        <VerifiedHeroCard
          identity={savedIdentity}
          clientId={cfg.oauthClientId}
          redirectUri={cfg.redirectUri}
          scope={scopeString}
          issuer={cfg.apiBaseUrl}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pre-link profile card — replaces the abstract "Authorize verification" hero
// ---------------------------------------------------------------------------

function PreLinkProfileCard({
  firmUser,
  clientId,
  redirectUri,
  scope,
  issuer,
}: {
  readonly firmUser: {
    readonly id: string;
    readonly email: string;
    readonly displayName: string | null;
  };
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly issuer: string;
}) {
  // Real registration name takes precedence over email-derived
  // guesses — that path read as "Demo" for a `demo@…` address.
  // The legacy email-derived helpers stay as the fallback for
  // back-compat with pre-displayName users persisted on disk.
  const hasRealName = firmUser.displayName !== null && firmUser.displayName.length > 0;
  const displayName = hasRealName
    ? (firmUser.displayName as string)
    : deriveDisplayName(firmUser.email);
  const initials = hasRealName
    ? initialsFromDisplayName(firmUser.displayName as string)
    : deriveAvatarInitials(firmUser.email);

  return (
    <div className="overflow-hidden rounded-2xl border border-stone-800 bg-stone-900/30">
      <div className="px-6 py-8 sm:px-10 sm:py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <Avatar initials={initials} />
            <div className="min-w-0">
              <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
                dApp account
              </p>
              <h2 className="mt-1.5 truncate font-serif text-[22px] font-normal leading-tight tracking-tight text-stone-50">
                {displayName}
              </h2>
              <p className="mt-1 font-mono text-[12px] text-stone-500">{firmUser.email}</p>
              <p className="mt-3 flex items-center gap-2 text-[12px]">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-stone-700 bg-stone-900/60 px-2.5 py-0.5 text-[11.5px] font-medium text-stone-400">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 rounded-full bg-stone-600"
                  />
                  <span>Not Verified</span>
                </span>
                <span className="text-stone-700">·</span>
                <span className="font-mono text-[11.5px] text-stone-500">
                  Level <span className="text-stone-400">-</span>
                </span>
              </p>
            </div>
          </div>
          <div className="shrink-0">
            <CrivacyVerifyButton
              clientId={clientId}
              redirectUri={redirectUri}
              scope={scope}
              issuer={issuer}
              label="Verify with Crivacy"
            />
          </div>
        </div>

      </div>

      <div className="border-t border-stone-800/80 bg-stone-950/40 px-5 py-5 sm:px-8 sm:py-6">
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
          <FeatureCell
            icon={RefreshCw}
            title="Reusable"
            body="Reused across any Crivacy-integrated firm, no second KYC."
          />
          <FeatureCell
            icon={Layers}
            title="On chain"
            body="Anchored on Sepolia. Tamper evident."
          />
          <FeatureCell
            icon={Lock}
            title="Private by design"
            body="No name, document, or biometric data shared with this dApp."
          />
        </ul>
      </div>
    </div>
  );
}

/**
 * Two-letter initials from a real display name. "Faruk Özden" → "FÖ",
 * "Jane" → "J", empty → "?".
 */
function initialsFromDisplayName(name: string): string {
  const tokens = name
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (tokens.length === 0) return '?';
  if (tokens.length === 1) return tokens[0]![0]!.toUpperCase();
  return `${tokens[0]![0]!}${tokens[tokens.length - 1]![0]!}`.toUpperCase();
}

function Avatar({ initials }: { readonly initials: string }) {
  return (
    <div
      aria-hidden
      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-stone-700 bg-stone-900/80 font-mono text-[16px] font-semibold tracking-tight text-stone-200"
    >
      {initials}
    </div>
  );
}

function FeatureCell({
  icon: Icon,
  title,
  body,
}: {
  readonly icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  readonly title: string;
  readonly body: string;
}) {
  return (
    <li className="rounded-xl border border-stone-800/80 bg-stone-950/60 px-4 py-4 sm:px-5 sm:py-5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-stone-800 bg-stone-900/60 text-stone-400"
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <p className="font-serif text-[15px] font-normal text-stone-100">{title}</p>
          <p className="mt-1 text-[12.5px] leading-[1.7] text-stone-400">{body}</p>
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Verified state — same hero card the previous version had, extended with
// lifecycle banners, the independent Sepolia check, an unlink action, and a
// privacy-posture footer line.
// ---------------------------------------------------------------------------

function VerifiedHeroCard({
  identity,
  clientId,
  redirectUri,
  scope,
  issuer,
}: {
  readonly identity: OauthIdentityRecord;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly issuer: string;
}) {
  const claims = identity.claims;
  const level = typeof claims.credential_level === 'string' ? claims.credential_level : null;
  const validUntil =
    typeof claims.credential_valid_until === 'string' ? claims.credential_valid_until : null;
  const network = typeof claims.credential_network === 'string' ? claims.credential_network : null;
  const contractId =
    typeof claims.credential_contract_id === 'string' ? claims.credential_contract_id : null;
  const proofHash =
    typeof claims.credential_proof_hash === 'string' ? claims.credential_proof_hash : null;

  const isRevoked = identity.revokedAt !== null;
  const isExpired = identity.expiredAt !== null;

  return (
    <div className="overflow-hidden rounded-2xl border border-stone-800 bg-stone-900/30">
      {/* Lifecycle banner — only when revoked or expired. Sits ABOVE
          the hero so the user sees the new state before the (stale)
          verified pills below. */}
      {isRevoked || isExpired ? (
        <LifecycleBanner
          kind={isRevoked ? 'revoked' : 'expired'}
          reason={isRevoked ? identity.revokeReason : null}
          observedAt={isRevoked ? identity.revokedAt! : identity.expiredAt!}
        />
      ) : null}

      <div className="px-6 py-8 sm:px-10 sm:py-10">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div
              aria-hidden
              className={
                isRevoked || isExpired
                  ? 'flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-rose-900/60 bg-rose-950/40 text-rose-300'
                  : 'flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-stone-700 bg-stone-900/60 text-[#cc785c]'
              }
            >
              {isRevoked || isExpired ? (
                <ShieldAlert className="h-6 w-6" strokeWidth={1.5} />
              ) : (
                <BadgeCheck className="h-6 w-6" strokeWidth={1.5} />
              )}
            </div>
            <div className="min-w-0">
              <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
                {isRevoked
                  ? 'identity.revoked'
                  : isExpired
                    ? 'identity.expired'
                    : 'identity.verified'}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                <h2 className="font-serif text-[24px] font-normal leading-none tracking-tight text-stone-50">
                  {isRevoked ? 'Revoked' : isExpired ? 'Expired' : 'Verified'}
                </h2>
                {level !== null ? <LevelChip level={level} dim={isRevoked || isExpired} /> : null}
              </div>
              <p className="mt-1.5 font-mono text-[11px] text-stone-500">
                linked {formatRelative(identity.firstLinkedAt)}
                {identity.lastUpdatedAt !== identity.firstLinkedAt
                  ? ` / refresh ${formatRelative(identity.lastUpdatedAt)}`
                  : ''}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <UnlinkCrivacyButton />
            <CrivacyVerifyButton
              clientId={clientId}
              redirectUri={redirectUri}
              scope={scope}
              issuer={issuer}
              variant="ghost"
              label="Re verify"
              busyLabel="Refreshing"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 divide-y divide-stone-800/80 border-t border-stone-800/80 lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <div className="px-6 py-7 sm:px-10 sm:py-8">
          <SectionHeading icon={ShieldCheck} label="Verification status" />
          <dl className="mt-5 space-y-4">
            <ClaimRow
              icon={ScanFace}
              label="Identity"
              verified={claims.identity_verified === true && !isRevoked && !isExpired}
            />
            <ClaimRow
              icon={ScanFace}
              label="Liveness"
              verified={claims.liveness_verified === true && !isRevoked && !isExpired}
            />
            <ClaimRow
              icon={MapPin}
              label="Address"
              verified={claims.address_verified === true && !isRevoked && !isExpired}
            />
          </dl>
        </div>

        <div className="px-6 py-7 sm:px-10 sm:py-8">
          <SectionHeading icon={Layers} label="On chain proof" />
          <dl className="mt-5 space-y-4">
            <DetailRow
              icon={Layers}
              label="Network"
              value={network !== null ? <NetworkChip network={network} /> : <Muted />}
            />
            <DetailRow
              icon={Hash}
              label="Contract ID"
              value={
                contractId !== null ? (
                  <code className="font-mono text-[12px] text-stone-200">
                    {truncateMiddle(contractId, 8, 6)}
                  </code>
                ) : (
                  <Muted />
                )
              }
            />
            <DetailRow
              icon={Hash}
              label="Proof hash"
              value={
                proofHash !== null ? (
                  <code className="font-mono text-[12px] text-stone-200">
                    {truncateMiddle(proofHash, 8, 6)}
                  </code>
                ) : (
                  <Muted />
                )
              }
            />
            <DetailRow
              icon={Clock}
              label="Valid until"
              value={
                validUntil !== null ? (
                  <span className="text-[13px] text-stone-200">
                    {new Date(validUntil).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                ) : (
                  <Muted />
                )
              }
            />
          </dl>
        </div>
      </div>

      {/* Independent Sepolia check — the firm's own validator says yes/no. */}
      {contractId !== null ? (
        <div className="border-t border-stone-800/80 bg-stone-950/30 px-6 py-6 sm:px-10">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <SectionHeading icon={ShieldCheck} label="Independent on-chain check" />
            <p className="text-[11.5px] text-stone-500">
              Query Sepolia directly, with no Crivacy library involved.
            </p>
          </div>
          <IndependentFheCheck />
        </div>
      ) : null}

      {/* Privacy posture footer — make the non-PII contract visible. */}
      <div className="border-t border-stone-800/80 bg-stone-950/40 px-6 py-4 sm:px-10">
        <div className="flex items-start gap-2">
          <Lock
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-500"
            aria-hidden="true"
            strokeWidth={1.75}
          />
          <p className="text-[12px] leading-[1.7] text-stone-500">
            <span className="font-medium text-stone-300">No PII transmitted.</span> Crivacy
            does not share name, document number, address text, or biometric inputs with this
            dApp. Verified flags + on-chain proof only.
          </p>
        </div>
      </div>

      <div className="border-t border-stone-800/80 bg-stone-950/30 px-6 py-3.5 sm:px-10">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11.5px] text-stone-500">
          <div className="flex items-center gap-1.5">
            <span className="text-stone-600">sub</span>
            <code className="text-stone-300">
              {truncateMiddle(identity.crivacySub, 6, 4)}
            </code>
          </div>
          <div className="h-3 w-px bg-stone-800" aria-hidden />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-stone-600">scope</span>
            {identity.scope.split(/\s+/).map((s) => (
              <span
                key={s}
                className="rounded border border-stone-800 bg-stone-900/60 px-1.5 py-0.5 text-[10.5px] text-stone-300"
              >
                {s}
              </span>
            ))}
          </div>
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-stone-600">
            <span>persisted in dapp store</span>
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" strokeWidth={1.75} />
          </span>
        </div>
      </div>
    </div>
  );
}

function LifecycleBanner({
  kind,
  reason,
  observedAt,
}: {
  readonly kind: 'revoked' | 'expired';
  readonly reason: string | null;
  readonly observedAt: string;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-rose-900/60 bg-rose-950/30 px-6 py-3.5 text-[13px] text-rose-200 sm:px-10"
    >
      <ShieldAlert
        className="mt-0.5 h-4 w-4 shrink-0 text-rose-400"
        aria-hidden="true"
        strokeWidth={1.75}
      />
      <div className="min-w-0">
        <p className="font-medium text-rose-100">
          {kind === 'revoked'
            ? 'Credential revoked by issuer'
            : 'Credential expired'}
        </p>
        <p className="mt-0.5 text-[12px] text-rose-300/90">
          {kind === 'revoked' ? (
            <>
              Crivacy notified this dApp that the credential is no longer valid
              {reason !== null && reason.length > 0 ? (
                <>
                  {' ('}
                  <span className="font-mono text-[11.5px] text-rose-300">
                    reason: {reason}
                  </span>
                  {')'}
                </>
              ) : null}
              . Re-verify to refresh.
            </>
          ) : (
            <>
              The credential&apos;s <code className="font-mono text-[11.5px]">valid_until</code>{' '}
              window has elapsed. Re-verify to refresh.
            </>
          )}{' '}
          <span className="font-mono text-[11px] text-rose-400/80">
            ({formatRelative(observedAt)})
          </span>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SectionHeading({
  icon: Icon,
  label,
}: {
  readonly icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  readonly label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-3.5 w-3.5 text-stone-500" strokeWidth={1.75} aria-hidden="true" />
      <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
        {label}
      </p>
    </div>
  );
}

function ClaimRow({
  icon: Icon,
  label,
  verified,
  valueText,
}: {
  readonly icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  readonly label: string;
  readonly verified?: boolean;
  readonly valueText?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <Icon className="h-4 w-4 shrink-0 text-stone-500" strokeWidth={1.75} aria-hidden="true" />
        <span className="text-[14px] text-stone-300">{label}</span>
      </div>
      {verified !== undefined ? (
        <span
          className={
            verified
              ? 'inline-flex items-center gap-1.5 rounded-full border border-[#cc785c]/30 bg-[#cc785c]/10 px-2.5 py-0.5 text-[11.5px] font-medium text-[#e8a684]'
              : 'inline-flex items-center gap-1.5 rounded-full border border-stone-700 bg-stone-900/60 px-2.5 py-0.5 text-[11.5px] font-medium text-stone-400'
          }
        >
          {verified ? (
            <>
              <BadgeCheck className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              <span>Verified</span>
            </>
          ) : (
            <span>Not verified</span>
          )}
        </span>
      ) : (
        <span className="text-[13px] font-medium tabular-nums text-stone-200">
          {valueText ?? '-'}
        </span>
      )}
    </div>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  readonly label: string;
  readonly value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <Icon className="h-4 w-4 shrink-0 text-stone-500" strokeWidth={1.75} aria-hidden="true" />
        <span className="text-[14px] text-stone-300">{label}</span>
      </div>
      <div className="text-right">{value}</div>
    </div>
  );
}

function LevelChip({ level, dim }: { readonly level: string; readonly dim?: boolean }) {
  const isEnhanced = level.toLowerCase() === 'enhanced';
  if (dim === true) {
    return (
      <span className="inline-flex items-center rounded-full border border-stone-800 bg-stone-900/60 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-stone-500 line-through">
        {level}
      </span>
    );
  }
  return (
    <span
      className={
        isEnhanced
          ? 'inline-flex items-center rounded-full bg-[#cc785c] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-stone-50'
          : 'inline-flex items-center rounded-full border border-stone-700 bg-stone-900/60 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-stone-300'
      }
    >
      {level}
    </span>
  );
}

function NetworkChip({ network }: { readonly network: string }) {
  return (
    <span className="inline-flex items-center rounded border border-stone-800 bg-stone-900/80 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide text-stone-300">
      {network}
    </span>
  );
}

function Muted() {
  return <span className="text-[13px] text-stone-600">-</span>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateMiddle(value: string, head: number, tail: number): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const deltaSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (deltaSec < 45) return 'just now';
  if (deltaSec < 90) return '1 min ago';
  if (deltaSec < 60 * 60) return `${Math.round(deltaSec / 60)} min ago`;
  if (deltaSec < 24 * 60 * 60) return `${Math.round(deltaSec / 3600)} h ago`;
  return new Date(then).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
