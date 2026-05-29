/**
 * API reference content -- auto-generated from the OpenAPI spec.
 *
 * Server component that reads `docs/api/openapi.json` at build time,
 * groups endpoints by tag, and renders an `EndpointCard` for each
 * operation. If the spec file does not exist (e.g. first build before
 * `pnpm openapi:build`), the component renders a helpful fallback.
 *
 * @module
 */

import Link from 'next/link';

import { EndpointCard } from '@/components/docs/endpoint-card';
import { loadApiReference } from '@/lib/docs';
import { OPENAPI_INFO, OPENAPI_SERVERS } from '@/lib/openapi';

import type { ApiTagGroup } from '@/lib/docs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a stable anchor ID from a tag name. */
function tagAnchor(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ApiReferenceContent() {
  const tagGroups = loadApiReference();

  // ------ Empty state (spec not built yet) ------
  if (tagGroups.length === 0) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
        <h2 className="text-lg font-semibold text-[var(--color-fg)]">
          API reference not available yet
        </h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          The OpenAPI specification has not been generated. Run{' '}
          <code className="rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-1.5 py-0.5 text-xs">
            pnpm openapi:build
          </code>{' '}
          to produce{' '}
          <code className="rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-1.5 py-0.5 text-xs">
            docs/api/openapi.json
          </code>{' '}
          and rebuild this page.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-12">
      {/* ---------------------------------------------------------------- */}
      {/* Preamble: base URL + authentication                              */}
      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 id="base-url" className="text-xl font-semibold text-[var(--color-fg)]">
          Base URL
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">
          All API requests are made to one of the following base URLs. Use the production URL for
          live integrations and the playground proxy for interactive testing from the dashboard.
        </p>
        <ul className="mt-4 space-y-2">
          {OPENAPI_SERVERS.map((server) => (
            <li key={server.url} className="flex items-baseline gap-3">
              <code className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 font-mono text-xs text-[var(--color-fg)]">
                {server.url}
              </code>
              <span className="text-xs text-[var(--color-muted)]">{server.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 id="authentication" className="text-xl font-semibold text-[var(--color-fg)]">
          Authentication
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">
          Most endpoints require an API key sent via the{' '}
          <code className="rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-1.5 py-0.5 text-xs">
            x-api-key
          </code>{' '}
          header. Dashboard endpoints use a session cookie (JWT). Admin endpoints require JWT plus
          TOTP verification. See the{' '}
          <Link href="/docs/authentication" className="text-[var(--color-accent)] hover:underline">
            Authentication guide
          </Link>{' '}
          for details.
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Version info                                                     */}
      {/* ---------------------------------------------------------------- */}
      <section className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <span className="text-xs font-medium text-[var(--color-muted)]">API version</span>
        <code className="font-mono text-xs text-[var(--color-fg)]">{OPENAPI_INFO.version}</code>
        <span className="mx-1 h-3 w-px bg-[var(--color-border)]" />
        <span className="text-xs font-medium text-[var(--color-muted)]">OpenAPI</span>
        <code className="font-mono text-xs text-[var(--color-fg)]">3.1.0</code>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Tag groups                                                       */}
      {/* ---------------------------------------------------------------- */}
      {tagGroups.map((group) => (
        <TagSection key={group.tag} group={group} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tag section
// ---------------------------------------------------------------------------

function TagSection({ group }: { readonly group: ApiTagGroup }) {
  const anchor = tagAnchor(group.tag);

  return (
    <section id={anchor} className="scroll-mt-24">
      {/* Tag header */}
      <div className="mb-6 border-b border-[var(--color-border)] pb-4">
        <h2 className="text-2xl font-semibold tracking-tight text-[var(--color-fg)]">
          {group.tag}
        </h2>
        {group.description.length > 0 && (
          <p className="mt-1 text-sm text-[var(--color-muted)]">{group.description}</p>
        )}
      </div>

      {/* Endpoints, single `EndpointCard` per operation. The previous
       * revision double-rendered every endpoint (once inline with plain
       * text, once through `EndpointCard`) which is why every /api/v1/*
       * block showed a bare "Auth: apiKey" row followed by a properly
       * styled one underneath. Keeping the card as the single source
       * of visual truth means the MarkdownText chip rendering applies
       * everywhere the OpenAPI spec surfaces a description. */}
      <div className="space-y-6">
        {group.endpoints.map((endpoint) => (
          <EndpointCard
            key={`${endpoint.method}-${endpoint.path}`}
            method={endpoint.method}
            path={endpoint.path}
            summary={endpoint.summary}
            description={endpoint.description}
            parameters={endpoint.parameters.map((p) => ({
              name: p.name,
              in: p.in as 'path' | 'query' | 'header',
              required: p.required,
              type: p.schema,
              description: p.description,
            }))}
            requestBodySchema={endpoint.requestBody?.schemaRef ?? undefined}
            responses={endpoint.responses.map((r) => ({
              status: Number.parseInt(r.status, 10),
              description: r.description,
            }))}
            security={endpoint.security.length > 0 ? endpoint.security : undefined}
            minTier={endpoint.minTier ?? undefined}
          />
        ))}
      </div>
    </section>
  );
}
