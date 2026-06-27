/**
 * Test-FHE-Dapp landing. Editorial dApp homepage. Crivacy gateway
 * surfaces as a flow sticker plus an expandable integration spec
 * section. Snippets in the expanded panels are pulled from the same
 * `multi-lang-templates.ts` builder the docs and dashboard
 * quickstart drawer use, so a developer reading them sees byte
 * identical code on every surface.
 */

import { cookies } from 'next/headers';
import Link from 'next/link';
import { ArrowRight, Code2, Cpu, Hash, Key, Webhook } from 'lucide-react';

import { CodeBlock } from '@/components/shared/code-block';
import { MultiLangSnippet } from '@/components/docs/multi-lang-snippet';
import { buildMultiLangTemplates } from '@/lib/integration/multi-lang-templates';
import { TF_SESSION_COOKIE } from './session';
import { findUserBySession } from './user-store';
import { loadTestFirmConfig, TEST_FIRM_SCOPES } from './config';
import { IntegrationSpec, type IntegrationSpecItem } from './ui/integration-spec';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Verbatim Node.js webhook signature verify snippet from
// `content/docs/webhooks.mdx`. Kept inline here so the dApp surfaces
// the same code a firm reading the docs would copy. Hand edits to
// the snippet must mirror the docs source.
// ---------------------------------------------------------------------------
const WEBHOOK_VERIFY_SNIPPET = `import crypto from 'node:crypto';

function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => {
      const [key, value] = part.split('=');
      return [key, value];
    })
  );

  const timestamp = parts.t;
  const receivedHmac = parts.v1;

  // Reject if timestamp is older than 5 minutes
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (Math.abs(age) > 300) {
    throw new Error('Webhook timestamp too old or too far in the future');
  }

  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(\`\${timestamp}.\${rawBody}\`)
    .digest('hex');

  const isValid = crypto.timingSafeEqual(
    Buffer.from(receivedHmac, 'hex'),
    Buffer.from(expectedHmac, 'hex')
  );

  if (!isValid) {
    throw new Error('Invalid webhook signature');
  }

  return JSON.parse(rawBody);
}

// Usage in Express
app.post('/webhooks/crivacy', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = verifyWebhookSignature(
      req.body.toString(),
      req.headers['x-crivacy-signature'],
      process.env.CRIVACY_WEBHOOK_SECRET
    );
    // Process event...
    res.status(200).json({ received: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});`;

export default async function TestFirmHome({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get(TF_SESSION_COOKIE)?.value ?? null;
  const user = findUserBySession(token);
  const params = await searchParams;
  const error = params.error ?? null;

  const cfg = loadTestFirmConfig();
  const templates = buildMultiLangTemplates({
    clientId: cfg.oauthClientId,
    redirectUri: cfg.redirectUri,
    scopes: TEST_FIRM_SCOPES,
    isPublicClient: false,
    issuerOrigin: cfg.apiBaseUrl,
  });
  const snippetParams = {
    clientId: cfg.oauthClientId,
    redirectUri: cfg.redirectUri,
    scopes: [...TEST_FIRM_SCOPES],
    issuerOrigin: cfg.apiBaseUrl,
  } as const;

  const specItems: IntegrationSpecItem[] = [
    {
      eyebrow: 'Frontend',
      title: 'Drop in button',
      icon: <Code2 className="h-3.5 w-3.5" strokeWidth={1.75} />,
      summary: (
        <>
          One <Mono>script</Mono> tag plus a <Mono>button[data-crivacy-verify]</Mono>.
          The script handles PKCE state, verifier and the redirect.
        </>
      ),
      content: <CodeBlock code={templates.htmlDropIn} language="http" />,
    },
    {
      eyebrow: 'Backend',
      title: 'Token exchange',
      icon: <Key className="h-3.5 w-3.5" strokeWidth={1.75} />,
      summary: (
        <>
          <Mono>POST /oauth/token</Mono> with <Mono>code</Mono> and{' '}
          <Mono>code_verifier</Mono>. <Mono>client_secret</Mono> stays server side.
        </>
      ),
      content: (
        <MultiLangSnippet
          step="callback"
          clientId={snippetParams.clientId}
          redirectUri={snippetParams.redirectUri}
          scopes={snippetParams.scopes}
          issuerOrigin={snippetParams.issuerOrigin}
          pinIsPublicClient={false}
        />
      ),
    },
    {
      eyebrow: 'Claims',
      title: 'Userinfo JSON',
      icon: <Hash className="h-3.5 w-3.5" strokeWidth={1.75} />,
      summary: (
        <>
          <Mono>identity_verified</Mono>, <Mono>liveness</Mono>,{' '}
          <Mono>address</Mono>, plus an on chain <Mono>contract_id</Mono> and proof hash.
        </>
      ),
      content: (
        <MultiLangSnippet
          step="userinfo"
          clientId={snippetParams.clientId}
          redirectUri={snippetParams.redirectUri}
          scopes={snippetParams.scopes}
          issuerOrigin={snippetParams.issuerOrigin}
          pinIsPublicClient={false}
        />
      ),
    },
    {
      eyebrow: 'Lifecycle',
      title: 'Signed webhooks',
      icon: <Webhook className="h-3.5 w-3.5" strokeWidth={1.75} />,
      summary: (
        <>
          Session state and credential lifecycle posted to your endpoint.{' '}
          <Mono>X-Crivacy-Signature</Mono> header, HMAC SHA256, verified before processing.
        </>
      ),
      content: <CodeBlock code={WEBHOOK_VERIFY_SNIPPET} language="javascript" />,
    },
  ];

  return (
    <div className="space-y-14">
      <section className="space-y-6">
        <h1 className="font-serif text-[44px] font-normal leading-[1.05] tracking-tight text-stone-50 sm:text-[56px]">
          Northwind Finance.
          <br />
          <span className="italic text-stone-500">Verified customers only.</span>
        </h1>
        <p className="max-w-xl text-[15.5px] leading-[1.7] text-stone-400">
          Verify your identity once with Crivacy and access Northwind instantly. No documents
          are shared with us, and your credential stays yours on chain.
        </p>
      </section>

      {error !== null ? (
        <div className="rounded-lg border border-stone-800 bg-stone-900/40 px-4 py-3 text-sm text-stone-300">
          <code className="font-mono text-xs text-[#e08e6c]">{error}</code>
        </div>
      ) : null}

      {user === null && (
        <section className="grid gap-3 md:grid-cols-2">
          <ConnectCard
            title="Sign in"
            sub="Existing account"
            href="/login"
            cta="Continue"
            variant="primary"
          />
          <ConnectCard
            title="Register"
            sub="Create an account"
            href="/register"
            cta="New account"
            variant="ghost"
          />
        </section>
      )}

      <section className="space-y-6">
        <SectionHeading
          eyebrow="What we use from Crivacy"
          title="The integration shape"
          sub="Pick any step to inspect the snippet. Same code the docs and the dashboard quickstart drawer ship."
        />
        <IntegrationSpec
          defaultActive={0}
          items={specItems}
        />
      </section>

      <section className="rounded-xl border border-stone-800 bg-stone-900/30 p-6 sm:p-8">
        <SectionHeading
          eyebrow="Stack"
          title="What runs underneath"
          sub="Sepolia testnet for the credential, Crivacy as the gateway, Didit handling document and biometric capture, this dApp on Next.js."
        />
        <ul className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <StackPill icon={Cpu} label="Chain" value="Sepolia" />
          <StackPill icon={Cpu} label="Gateway" value="Crivacy" />
          <StackPill icon={Cpu} label="KYC vendor" value="Didit" />
          <StackPill icon={Cpu} label="Runtime" value="Next.js" />
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SectionHeading({
  eyebrow,
  title,
  sub,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly sub?: string;
}) {
  return (
    <div className="space-y-2.5">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
        {eyebrow}
      </p>
      <h2 className="font-serif text-[24px] font-normal tracking-tight text-stone-50">{title}</h2>
      {sub !== undefined ? (
        <p className="max-w-2xl text-[14px] leading-[1.7] text-stone-400">{sub}</p>
      ) : null}
    </div>
  );
}

function ConnectCard({
  title,
  sub,
  href,
  cta,
  variant,
}: {
  readonly title: string;
  readonly sub: string;
  readonly href: string;
  readonly cta: string;
  readonly variant: 'primary' | 'ghost';
}) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between rounded-xl border border-stone-800 bg-stone-900/30 px-6 py-6 transition-colors hover:border-stone-700 hover:bg-stone-900/50"
    >
      <div className="min-w-0">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">{title}</p>
        <p className="mt-1.5 font-serif text-[18px] font-normal tracking-tight text-stone-100">{sub}</p>
      </div>
      <span
        className={
          variant === 'primary'
            ? 'inline-flex items-center gap-1.5 rounded-md bg-[#cc785c] px-3.5 py-2 text-[13px] font-medium text-stone-50 transition-colors group-hover:bg-[#d4886e]'
            : 'inline-flex items-center gap-1.5 rounded-md border border-stone-700 bg-stone-900 px-3.5 py-2 text-[13px] font-medium text-stone-100 transition-colors group-hover:border-stone-600 group-hover:bg-stone-800/80'
        }
      >
        {cta}
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </Link>
  );
}

function StackPill({
  icon: Icon,
  label,
  value,
}: {
  readonly icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  readonly label: string;
  readonly value: string;
}) {
  return (
    <li className="flex items-center gap-2.5 rounded-md border border-stone-800 bg-stone-950/40 px-3 py-2">
      <Icon className="h-3.5 w-3.5 shrink-0 text-stone-500" strokeWidth={1.75} aria-hidden="true" />
      <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-stone-500">
        {label}
      </span>
      <span className="ml-auto text-[12.5px] font-medium text-stone-100">{value}</span>
    </li>
  );
}

function Mono({ children }: { readonly children: React.ReactNode }) {
  return (
    <code className="rounded bg-stone-800/70 px-1 py-0.5 font-mono text-[11px] text-stone-200">
      {children}
    </code>
  );
}
