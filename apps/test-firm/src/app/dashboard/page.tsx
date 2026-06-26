/**
 * Test-FHE-Dapp dashboard. Identity panel up top, integration
 * testbench beneath. Stone palette, restrained accent, serif heads.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Server, ShieldCheck, Webhook } from 'lucide-react';

import {
  listKycSessionsForUser,
  listOauthIdentitiesForUser,
  type OauthIdentityRecord,
} from '../data-store';
import { TF_SESSION_COOKIE } from '../session';
import { findUserBySession } from '../user-store';
import { SessionApiPanel } from './session-api-panel';
import { OauthPanel } from './oauth-panel';
import { WebhookPanel } from './webhook-panel';

export const dynamic = 'force-dynamic';

export default async function TestFirmDashboard({
  searchParams,
}: {
  searchParams: Promise<{ oauth_error?: string }>;
}) {
  const cookieStore = await cookies();

  const tfToken = cookieStore.get(TF_SESSION_COOKIE)?.value ?? null;
  const tfUser = findUserBySession(tfToken);
  if (tfUser === null) {
    redirect('/login');
  }

  const oauthIdentities = listOauthIdentitiesForUser(tfUser.id);
  const kycSessions = listKycSessionsForUser(tfUser.id);
  const params = await searchParams;
  const oauthError = params.oauth_error ?? null;

  return (
    <div className="space-y-12">
      <DashboardHeader
        displayName={tfUser.displayName}
        email={tfUser.email}
        identity={oauthIdentities[0] ?? null}
      />

      <OauthPanel
        savedIdentity={oauthIdentities[0] ?? null}
        errorCode={oauthError}
        firmUser={{
          id: tfUser.id,
          email: tfUser.email,
          displayName: tfUser.displayName,
        }}
      />

      <SectionDivider />

      <PathSection
        icon={Server}
        eyebrow="No account? No problem"
        title="Verify a customer who doesn't have a Crivacy account"
        body="Start a verification from your server. The customer completes it on their phone, and the verified result comes back to you automatically. No signup needed on their end."
      >
        <SessionApiPanel defaultUserRef={tfUser.id} savedSessions={kycSessions} />
      </PathSection>

      <PathSection
        icon={Webhook}
        eyebrow="Live updates"
        title="Verification updates, as they happen"
        body="Crivacy notifies us the moment a verification changes. New approvals, revocations, and expirations arrive here in real time, so your status is always current."
      >
        <WebhookPanel />
      </PathSection>
    </div>
  );
}

function PathSection({
  icon: Icon,
  eyebrow,
  title,
  body,
  children,
}: {
  readonly icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section aria-label={eyebrow} className="space-y-5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-stone-800 bg-stone-900/60 text-[#cc785c]"
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
            {eyebrow}
          </p>
          <p className="mt-1 font-serif text-[18px] font-normal leading-snug tracking-tight text-stone-50">
            {title}
          </p>
          <p className="mt-1.5 max-w-3xl text-[12.5px] leading-[1.7] text-stone-400">
            {body}
          </p>
        </div>
      </div>
      {children}
    </section>
  );
}

function SectionDivider() {
  return (
    <div aria-hidden className="flex items-center gap-5 py-2">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-stone-700 to-stone-600" />
      <span className="h-1.5 w-1.5 rounded-full bg-[#cc785c] shadow-[0_0_8px_rgba(204,120,92,0.45)]" />
      <div className="h-px flex-1 bg-gradient-to-l from-transparent via-stone-700 to-stone-600" />
    </div>
  );
}

function DashboardHeader({
  displayName,
  email,
  identity,
}: {
  readonly displayName: string | null;
  readonly email: string;
  readonly identity: OauthIdentityRecord | null;
}) {
  const claims = identity?.claims;
  const level = typeof claims?.credential_level === 'string' ? claims.credential_level : null;
  const verified =
    identity !== null && identity.revokedAt === null && identity.expiredAt === null;
  const levelLabel =
    level !== null ? level.charAt(0).toUpperCase() + level.slice(1) : null;
  const name =
    displayName !== null && displayName.trim().length > 0
      ? displayName
      : (email.split('@')[0] ?? 'Account');
  const avatarUrl = `https://i.pravatar.cc/128?u=${encodeURIComponent(email)}`;

  return (
    <header className="flex items-center gap-4 sm:gap-5">
      <div className="relative shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element -- external avatar, no next/image domain config in this demo app */}
        <img
          src={avatarUrl}
          alt={name}
          className="h-16 w-16 rounded-full object-cover ring-1 ring-stone-700"
        />
        {verified && (
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 ring-2 ring-[#1c1b18]"
          >
            <ShieldCheck className="h-3 w-3 text-white" strokeWidth={2.5} />
          </span>
        )}
      </div>
      <div className="min-w-0">
        <h1 className="truncate font-serif text-[26px] font-normal leading-tight tracking-tight text-stone-50">
          {name}
        </h1>
        <p className="mt-0.5 truncate font-mono text-[12px] text-stone-500">{email}</p>
        <div className="mt-2.5">
          {verified && levelLabel !== null ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-800/60 bg-emerald-950/40 px-3 py-1 text-[11.5px] font-medium text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Verified · {levelLabel} KYC
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-stone-700 bg-stone-900/60 px-3 py-1 text-[11.5px] font-medium text-stone-400">
              Not verified
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

