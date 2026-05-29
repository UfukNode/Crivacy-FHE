/**
 * API reference endpoint card -- renders a single API endpoint.
 *
 * Server component. Displays the HTTP method badge (color-coded), path,
 * summary, parameters table, request body schema reference, response
 * status codes, security requirements, and minimum pricing tier badge.
 * @module
 */

import { MarkdownText } from './markdown-text';
import { TryItButton } from './try-it-button';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EndpointParameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly type: string;
  readonly description: string;
}

export interface EndpointResponse {
  readonly status: number;
  readonly description: string;
}

export interface EndpointCardProps {
  /** HTTP method (GET, POST, PATCH, DELETE). */
  readonly method: string;
  /** Full path, e.g. `/api/v1/sessions`. */
  readonly path: string;
  /** Short summary of what the endpoint does. */
  readonly summary: string;
  /** Detailed description (rendered as plain text). */
  readonly description?: string | undefined;
  /** Path, query, and header parameters. */
  readonly parameters?: readonly EndpointParameter[] | undefined;
  /** Request body schema reference name (e.g. `CreateSessionRequest`). */
  readonly requestBodySchema?: string | undefined;
  /** Response status codes and descriptions. */
  readonly responses?: readonly EndpointResponse[] | undefined;
  /** Security requirement names (e.g. `['apiKey']`). */
  readonly security?: readonly string[] | undefined;
  /** Minimum pricing tier required to access this endpoint. */
  readonly minTier?: string | undefined;
}

// ---------------------------------------------------------------------------
// Method badge color mapping
// ---------------------------------------------------------------------------

const METHOD_STYLES: Record<string, string> = {
  GET: 'bg-[var(--color-accent)]/15 text-[var(--color-accent)] border-[var(--color-accent)]/30',
  POST: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  PATCH: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  PUT: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  DELETE: 'bg-red-500/15 text-red-400 border-red-500/30',
};

const DEFAULT_METHOD_STYLE = 'bg-gray-500/15 text-gray-400 border-gray-500/30';

// ---------------------------------------------------------------------------
// Tier badge color mapping
// ---------------------------------------------------------------------------

const TIER_STYLES: Record<string, string> = {
  free: 'bg-[var(--color-surface)] text-[var(--color-muted)] border-[var(--color-border)]',
  starter: 'bg-blue-500/10 text-blue-400 border-blue-500/25',
  pro: 'bg-violet-500/10 text-violet-400 border-violet-500/25',
  enterprise: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
};

const DEFAULT_TIER_STYLE =
  'bg-[var(--color-surface)] text-[var(--color-muted)] border-[var(--color-border)]';

// ---------------------------------------------------------------------------
// Security label mapping
// ---------------------------------------------------------------------------

const SECURITY_LABELS: Record<string, string> = {
  apiKey: 'API Key (X-API-Key)',
  sessionCookie: 'Dashboard Session',
  adminSessionCookie: 'Admin Session + TOTP',
  diditWebhookSignature: 'Webhook Signature',
  none: 'Public (no auth)',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EndpointCard({
  method,
  path,
  summary,
  description,
  parameters,
  requestBodySchema,
  responses,
  security,
  minTier,
}: EndpointCardProps) {
  const upperMethod = method.toUpperCase();
  const methodStyle = METHOD_STYLES[upperMethod] ?? DEFAULT_METHOD_STYLE;
  const tierStyle = minTier ? (TIER_STYLES[minTier] ?? DEFAULT_TIER_STYLE) : null;

  return (
    <section className="my-6 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* Header: method + path + badges */}
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-5 py-4">
        {/* Method badge */}
        <span
          className={`inline-flex items-center rounded-[var(--radius-sm)] border px-2 py-0.5 font-mono text-xs font-bold uppercase tracking-wider ${methodStyle} `}
        >
          {upperMethod}
        </span>

        {/* Path */}
        <code className="font-mono text-sm font-medium text-[var(--color-fg)]">{path}</code>

        {/* Spacer */}
        <span className="flex-1" />

        {/* Min tier badge */}
        {minTier && tierStyle && (
          <span
            className={`inline-flex items-center rounded-[var(--radius-full)] border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tierStyle} `}
          >
            {minTier}
          </span>
        )}

        {/* Try it button */}
        <TryItButton method={upperMethod} path={path} />
      </div>

      {/* Body */}
      <div className="space-y-6 px-5 py-5">
        {/* Summary + description */}
        <div>
          <h3 className="text-[17px] font-semibold tracking-tight text-[var(--color-fg)]">
            <MarkdownText>{summary}</MarkdownText>
          </h3>
          {description && (
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-muted)]">
              <MarkdownText>{description}</MarkdownText>
            </p>
          )}
          {/* Auth pill sits inline with the summary so the reader sees
              "which credential do I need" at a glance instead of
              having to scan down through parameters first. */}
          {security && security.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                Auth
              </span>
              {security.map((scheme) => (
                <span
                  key={scheme}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent)]"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className="h-3 w-3"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v4A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-4A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z"
                      clipRule="evenodd"
                    />
                  </svg>
                  {SECURITY_LABELS[scheme] ?? scheme}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Parameters, definition-list layout instead of a table.
         * A table works for a single row but once the description
         * runs long the columns stretch awkwardly and the eye loses
         * the Name <> Description pairing. Stripe / Auth0 / Plaid
         * all use the dl layout for the same reason: each param is a
         * self-contained card with the metadata badges stacked above
         * the prose body. */}
        {parameters && parameters.length > 0 && (
          <div>
            <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-muted)]">
              Parameters
            </h4>
            <dl className="divide-y divide-[var(--color-border)] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
              {parameters.map((param) => (
                <div
                  key={`${param.in}-${param.name}`}
                  className="px-4 py-3 transition-colors hover:bg-[var(--color-bg)]"
                >
                  <dt className="flex flex-wrap items-center gap-2">
                    <code className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 font-mono text-[13px] font-medium text-[var(--color-accent)]">
                      {param.name}
                    </code>
                    <span className="rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
                      {param.in}
                    </span>
                    <span className="rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-fg)]">
                      {param.type}
                    </span>
                    {param.required ? (
                      <span className="rounded-[var(--radius-sm)] bg-[var(--color-danger)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-danger)]">
                        required
                      </span>
                    ) : (
                      <span className="rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
                        optional
                      </span>
                    )}
                  </dt>
                  {param.description.length > 0 && (
                    <dd className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-fg)] opacity-85">
                      <MarkdownText>{param.description}</MarkdownText>
                    </dd>
                  )}
                </div>
              ))}
            </dl>
          </div>
        )}

        {/* Request body */}
        {requestBodySchema && (
          <div>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
              Request body
            </h4>
            <p className="text-sm text-[var(--color-fg)]">
              Schema:{' '}
              <code className="rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-accent)]">
                {requestBodySchema}
              </code>
            </p>
          </div>
        )}

        {/* Response codes */}
        {responses && responses.length > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
              Responses
            </h4>
            <div className="space-y-1.5">
              {responses.map((res) => {
                let statusColor = 'text-[var(--color-muted)]';
                if (res.status >= 200 && res.status < 300) {
                  statusColor = 'text-[var(--color-success)]';
                } else if (res.status >= 400 && res.status < 500) {
                  statusColor = 'text-[var(--color-warning)]';
                } else if (res.status >= 500) {
                  statusColor = 'text-[var(--color-danger)]';
                }

                return (
                  <div
                    key={res.status}
                    className="flex items-baseline gap-3 rounded-[var(--radius-sm)] bg-[var(--color-bg)] px-3 py-1.5"
                  >
                    <span className={`font-mono text-xs font-bold ${statusColor}`}>
                      {res.status}
                    </span>
                    <span className="text-xs text-[var(--color-fg)]">
                      <MarkdownText>{res.description}</MarkdownText>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
