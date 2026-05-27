'use client';

/**
 * Integration Quick Start, right-side drawer that shows a firm
 * exactly what to paste into their code to wire up the OAuth flow
 * against *this specific* client.
 *
 * Two top-level tabs: **Drop-in HTML** (one-line branded button)
 * and **Multi-language code** (install → init → callback → userinfo
 * snippets in 7 languages, each with SDK + raw HTTP variants).
 *
 * Both tabs are fed by `lib/integration/multi-lang-templates.ts`,
 * the same source the docs `<MultiLangSnippet>` component consumes
 *, so a firm copying from this drawer sees byte-identical code
 * (modulo placeholder vs real client values) to a developer reading
 * `/docs/getting-started`. Single source of truth, zero drift.
 *
 * The drawer is read-only; it does not mutate state. It is opened
 * from the client row's "View code" action and from the
 * one-time-secret dialog right after client creation.
 */

import Link from 'next/link';
import type * as React from 'react';
import { useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';

import { MultiLangSnippet } from '@/components/docs/multi-lang-snippet';
import { CodeBlock } from '@/components/shared/code-block';
import { CopyButton } from '@/components/shared/copy-button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { buildMultiLangTemplates } from '@/lib/integration/multi-lang-templates';

export interface IntegrationQuickStartClient {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly allowedScopes: readonly string[];
  readonly isPublicClient: boolean;
}

export interface IntegrationQuickStartDrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly client: IntegrationQuickStartClient | null;
}

export function IntegrationQuickStartDrawer({
  open,
  onOpenChange,
  client,
}: IntegrationQuickStartDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {client === null ? null : <DrawerBody client={client} />}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({ client }: { readonly client: IntegrationQuickStartClient }) {
  // If the firm registered multiple redirect URIs, default to the
  // first; the dropdown lets them swap before copying.
  const [selectedRedirectUri, setSelectedRedirectUri] = useState<string>(
    client.redirectUris[0] ?? 'https://your.app/oauth/callback',
  );

  // `window.location.origin` keeps the generated snippets pointing
  // at whichever Crivacy origin the firm is currently logged into
  // (localhost, staging, production). Replaces the previous
  // hardcoded `https://app.crivacy.io` fallback.
  const issuerOrigin =
    typeof window !== 'undefined' ? window.location.origin : 'https://app.crivacy.io';

  // Build the parameterised HTML drop-in snippet, the multi-lang
  // snippets below consume their own copies of the templates via
  // the shared `MultiLangSnippet` component, but the drop-in is a
  // single language-agnostic block so we lift it out here.
  const htmlDropIn = useMemo(
    () =>
      buildMultiLangTemplates({
        clientId: client.clientId,
        redirectUri: selectedRedirectUri,
        scopes: client.allowedScopes,
        isPublicClient: client.isPublicClient,
        issuerOrigin,
      }).htmlDropIn,
    [client, selectedRedirectUri, issuerOrigin],
  );

  // Common props passed to every `<MultiLangSnippet>` in the drawer.
  // `pinIsPublicClient` ties the snippet to the firm's actual client
  // profile, the user already chose public-vs-confidential when
  // they created the client, so there's no per-snippet toggle to
  // expose here (unlike the docs page where the reader hasn't
  // chosen yet).
  const sharedSnippetProps = {
    clientId: client.clientId,
    redirectUri: selectedRedirectUri,
    scopes: client.allowedScopes,
    issuerOrigin,
    pinIsPublicClient: client.isPublicClient,
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>Integration for {client.name}</SheetTitle>
        <SheetDescription>
          Copy one of the snippets below into your app. Values are
          pre-filled from this client&apos;s settings, including the
          {client.isPublicClient ? ' public (PKCE only) ' : ' confidential '}
          profile you chose when creating it.
        </SheetDescription>
      </SheetHeader>

      {client.redirectUris.length > 1 && (
        <div className="mt-4">
          <label
            htmlFor="integration-redirect-uri"
            className="mb-1 block text-xs font-medium uppercase tracking-wider text-[var(--color-muted)]"
          >
            Redirect URI
          </label>
          <select
            id="integration-redirect-uri"
            value={selectedRedirectUri}
            onChange={(e) => setSelectedRedirectUri(e.target.value)}
            className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs"
          >
            {client.redirectUris.map((uri) => (
              <option key={uri} value={uri}>
                {uri}
              </option>
            ))}
          </select>
        </div>
      )}

      <Tabs defaultValue="code" className="mt-6">
        <TabsList>
          <TabsTrigger value="code">Multi-language code</TabsTrigger>
          <TabsTrigger value="dropin">Drop-in HTML</TabsTrigger>
        </TabsList>

        <TabsContent value="code" className="mt-4 space-y-6">
          <Section
            title="1. Install the SDK"
            description="Pick the package manager that matches your stack."
          >
            <MultiLangSnippet step="install" {...sharedSnippetProps} />
          </Section>
          <Section
            title="2. Initialise the client"
            description="Construct an SDK instance. The redirect URI + client_id are pre-filled with this client's values."
          >
            <MultiLangSnippet step="init" {...sharedSnippetProps} />
          </Section>
          <Section
            title="3. Handle the callback"
            description="On your /oauth/callback route, verify state, exchange the one-time code for tokens."
          >
            <MultiLangSnippet step="callback" {...sharedSnippetProps} />
          </Section>
          <Section
            title="4. Read the verification claims"
            description="Once you have an access_token, read the claim set from /oauth/userinfo."
          >
            <MultiLangSnippet step="userinfo" {...sharedSnippetProps} />
          </Section>
          <Section
            title="5. Verify the credential on-chain"
            description="Trustless step, Crivacy is not in the loop. Read the credential straight from the CrivacyKYC contract on Sepolia with your own viem client via the SDK helper; the chain is the source of truth."
          >
            <VerifyDisclosureSnippet clientId={client.clientId} />
            <p className="mt-3 text-xs leading-relaxed text-[var(--color-muted)]">
              JavaScript / TypeScript only today, the verifyDisclosure
              helper lives in @crivacy/js-sdk. Native Python / PHP /
              Java / .NET / Go / Ruby ports are on the roadmap. Until
              they ship, other stacks can read the CrivacyKYC contract
              directly via any Ethereum JSON-RPC client, see the{' '}
              <Link
                href="/docs/oauth#verify-the-disclosure-on-chain"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-accent)] hover:underline"
              >
                docs example
              </Link>{' '}
              for the wire format.
            </p>
          </Section>
        </TabsContent>

        <TabsContent value="dropin" className="mt-4 space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-[var(--color-fg)]">
              Drop into your page
            </h4>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Renders the branded &ldquo;Verify with Crivacy&rdquo; button.
              On click it redirects the current tab into the consent flow,
              no bundler, no install required.
            </p>
          </div>
          <div className="group relative">
            <CodeBlock code={htmlDropIn} language="http" />
            <FloatingCopyButton value={htmlDropIn} ariaLabel="Copy HTML drop-in code" />
          </div>
        </TabsContent>
      </Tabs>

      <div className="mt-8 border-t border-[var(--color-border)] pt-4">
        <Link
          href="/docs/oauth"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-accent)] hover:underline"
        >
          Full OAuth integration guide
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </>
  );
}

interface VerifyDisclosureSnippetProps {
  readonly clientId: string;
}

/**
 * Single-language (JS/TS) snippet for the on-chain verify step. Pinned here
 * rather than going through `multi-lang-templates.ts` because `verifyDisclosure()`
 * reads the credential straight from the CrivacyKYC contract on Sepolia with the
 * firm's own viem client, Crivacy is not in the trust loop. Wrapping the snippet
 * in the same `<CodeBlock>` + floating-copy chrome keeps the visual rhythm.
 */
function VerifyDisclosureSnippet({ clientId }: VerifyDisclosureSnippetProps) {
  const code = `import { CrivacyClient, verifyDisclosure } from '@crivacy/js-sdk';
import { createPublicClient, http, keccak256, toBytes } from 'viem';
import { sepolia } from 'viem/chains';

const crivacy = new CrivacyClient({
  clientId: '${clientId}',
  clientSecret: process.env.CRIVACY_CLIENT_SECRET!,
  redirectUri: 'https://your.app/oauth/callback',
});

// …complete Steps 3 + 4 above so you hold \`claims\`…

// Read the credential straight from the CrivacyKYC contract on Sepolia
// with YOUR OWN viem client. Crivacy is not in the trust loop for this
// verification, you trust the chain, not our API.
const view = await verifyDisclosure(claims, {
  publicClient: createPublicClient({ chain: sepolia, transport: http() }),
});

// \`status\` / \`isActive\` / \`validUntil\` are plaintext on-chain fields —
// no decryption, gate access on \`isActive\`.
if (!view.isActive) throw new Error('Credential not active on chain');

// \`userRefHash\` = keccak256 of the user id we bound at mint time.
// Recompute it to confirm the credential is for the user you expect.
if (view.userRefHash.toLowerCase() !== keccak256(toBytes(claims.sub)).toLowerCase()) {
  throw new Error('Credential bound to a different user');
}

// The sensitive fields (level, score, verification flags, the eligibility
// verdict) stay ENCRYPTED on chain as ciphertext handles in \`view.handles\`.
// A firm Crivacy granted per-firm ACL access decrypts the \`eligible\` handle
// with the Zama SDK; everyone else sees only ciphertext.`;

  return (
    <div className="group relative">
      <CodeBlock code={code} language="typescript" />
      <FloatingCopyButton
        value={code}
        ariaLabel="Copy verifyDisclosure example"
      />
    </div>
  );
}

interface SectionProps {
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}

function Section({ title, description, children }: SectionProps) {
  return (
    <section>
      <div className="mb-2">
        <h4 className="text-sm font-semibold text-[var(--color-fg)]">{title}</h4>
        {description !== undefined && (
          <p className="mt-1 text-xs text-[var(--color-muted)]">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * Theme-aware compact copy button, only rendered for the HTML
 * drop-in tab (the `<MultiLangSnippet>` blocks ship their own
 * matching button). Mirrors the MDX `<Pre>` button style: 28×28
 * subtle chip, hidden until the wrapping `.group` is hovered or
 * the button itself is focused.
 */
function FloatingCopyButton({
  value,
  ariaLabel,
}: {
  readonly value: string;
  readonly ariaLabel: string;
}) {
  return (
    <CopyButton
      value={value}
      iconOnly
      aria-label={ariaLabel}
      className="absolute right-2 top-2 h-7 w-7 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] opacity-0 transition-all duration-[var(--duration-fast)] hover:text-[var(--color-fg)] focus-visible:opacity-100 group-hover:opacity-100"
    />
  );
}
