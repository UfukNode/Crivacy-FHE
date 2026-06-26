'use client';

/**
 * Multi-language code-snippet block for docs MDX.
 *
 * Renders idiomatic per-language code samples for one OAuth
 * integration step. Two top-level variants: SDK (language-native
 * import + class) and Raw HTTP (language's standard library +
 * `/oauth/token` / `/oauth/userinfo` directly). Inner tab strip
 * picks the language. Optional public-vs-confidential client
 * toggle for the callback step.
 *
 * Reads from the single source of truth at
 * `lib/integration/multi-lang-templates.ts` — both the docs MDX
 * surface and the dashboard quickstart drawer eventually consume
 * the same builder so a customer copying from either surface sees
 * byte-identical code (modulo placeholder values).
 *
 * @module
 */

import { Check, Copy, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { CodeBlock, type CodeBlockLanguage } from '@/components/shared/code-block';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePreferredLanguage } from '@/lib/hooks/use-preferred-language';
import {
  buildMultiLangTemplates,
  type MultiLangTemplateParams,
} from '@/lib/integration/multi-lang-templates';
import {
  LANGUAGES,
  hasSdk,
  type IntegrationStep,
  type LanguageId,
  type SdkVariant,
} from '@/lib/integration/sdk-registry';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MultiLangSnippetProps {
  /** Which OAuth integration step this block renders. */
  readonly step: IntegrationStep;
  /**
   * OAuth client id placeholder. Defaults to a generic demo value
   * so the docs build doesn't need a real client. The dashboard
   * drawer pre-fills this with the firm's real `client_id`.
   */
  readonly clientId?: string;
  /** Redirect URI placeholder. */
  readonly redirectUri?: string;
  /** Scopes — space-joined for the wire and rendered in `authorize` calls. */
  readonly scopes?: readonly string[];
  /**
   * Origin where Crivacy's `/api/v1/oauth/*` endpoints live. Defaults
   * to the public production origin so docs render real values; the
   * dashboard passes `window.location.origin` so dev / staging
   * snippets reflect the current host.
   */
  readonly issuerOrigin?: string;
  /**
   * Whether to render the public-vs-confidential client toggle.
   * Defaults to `true` for the `callback` step (where the client
   * type changes the snippet) and `false` everywhere else. Forced
   * to `false` whenever `pinIsPublicClient` is set (the toggle
   * can't change a pinned value).
   */
  readonly showClientTypeToggle?: boolean;
  /**
   * Force the public-client flag to a specific value and hide the
   * toggle. Used by the dashboard quickstart drawer where the firm
   * has already chosen a client profile when registering the OAuth
   * client — there's no decision left for the snippet to expose.
   * Leave `undefined` (the docs default) to let the user toggle.
   */
  readonly pinIsPublicClient?: boolean;
  /** Initial SDK variant. Defaults to `sdk`. */
  readonly defaultVariant?: SdkVariant;
  /** Initial language. Defaults to `js`. */
  readonly defaultLanguage?: LanguageId;
}

const DEFAULT_CLIENT_ID = 'crv_oauth_live_xxxxxxxxxxxxx';
const DEFAULT_REDIRECT_URI = 'https://your.app/oauth/callback';
const DEFAULT_SCOPES: readonly string[] = ['openid', 'kyc'];
const DEFAULT_ISSUER = 'https://app.crivacy.io';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MultiLangSnippet(props: MultiLangSnippetProps) {
  const {
    step,
    clientId = DEFAULT_CLIENT_ID,
    redirectUri = DEFAULT_REDIRECT_URI,
    scopes = DEFAULT_SCOPES,
    issuerOrigin = DEFAULT_ISSUER,
    pinIsPublicClient,
    defaultVariant = 'sdk',
    defaultLanguage = 'js',
  } = props;

  // `install` + `init` are SDK-only — there's no meaningful "raw
  // HTTP install" since talking HTTP needs no install. For these
  // steps we hide the variant toggle and pin variant='sdk'.
  const stepIsSdkOnly = step === 'install' || step === 'init';

  // Pinning takes precedence over the docs-side default toggle.
  const showClientTypeToggle =
    pinIsPublicClient === undefined
      ? (props.showClientTypeToggle ?? step === 'callback')
      : false;

  const [variant, setVariant] = useState<SdkVariant>(
    stepIsSdkOnly ? 'sdk' : defaultVariant,
  );
  const [isPublicClientState, setIsPublicClientState] = useState(false);
  const isPublicClient = pinIsPublicClient ?? isPublicClientState;
  // Shared across every MultiLangSnippet on the page and persisted to
  // localStorage; clicking PHP in one block flips every other block
  // (and the dashboard quickstart drawer) to PHP at the same time.
  const [language, setLanguage] = usePreferredLanguage(defaultLanguage);

  const params: MultiLangTemplateParams = useMemo(
    () => ({
      clientId,
      redirectUri,
      scopes,
      isPublicClient,
      issuerOrigin,
    }),
    [clientId, redirectUri, scopes, isPublicClient, issuerOrigin],
  );

  const templates = useMemo(() => buildMultiLangTemplates(params), [params]);

  // Display order — for SDK variant we exclude cURL (no SDK exists);
  // for HTTP variant every language including cURL is shown.
  const displayLanguages = useMemo(
    () => LANGUAGES.filter((l) => (variant === 'http' ? true : l.hasSdk)),
    [variant],
  );

  // If the user toggles to a variant where the current language is
  // unavailable (only happens for cURL → SDK), snap back to JS so the
  // tab strip never has an "active" tab pointing at a hidden trigger.
  useEffect(() => {
    if (!displayLanguages.find((l) => l.id === language)) {
      setLanguage(displayLanguages[0]?.id ?? 'js');
    }
  }, [displayLanguages, language]);

  const code = useMemo(() => {
    if (variant === 'sdk' && hasSdk(language)) {
      return templates.sdk[language][step];
    }
    if (variant === 'http') {
      // `install` and `init` aren't HTTP-variant concepts. The
      // toggle hides for these steps but defensively render an
      // empty string if a caller forces variant='http' there.
      if (step === 'install' || step === 'init') return '';
      return templates.http[language][step];
    }
    return '';
  }, [variant, language, step, templates]);

  const meta = useMemo(
    () => LANGUAGES.find((l) => l.id === language),
    [language],
  );
  const highlight: CodeBlockLanguage = (meta?.syntaxHighlight ?? 'bash');

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="group relative my-6 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* Top bar — variant toggle + client type toggle (callback step only) */}
      {(!stepIsSdkOnly || showClientTypeToggle) && (
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-3 py-2">
          {!stepIsSdkOnly && (
            <Tabs
              value={variant}
              onValueChange={(v) => setVariant(v as SdkVariant)}
            >
              <TabsList className="h-8 bg-[var(--color-bg)] p-0.5">
                <TabsTrigger value="sdk" className="px-3 py-1 text-xs">
                  SDK
                </TabsTrigger>
                <TabsTrigger value="http" className="px-3 py-1 text-xs">
                  Raw HTTP
                </TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          {showClientTypeToggle && (
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-[var(--color-muted)]">
              <input
                type="checkbox"
                checked={isPublicClient}
                onChange={(e) => setIsPublicClientState(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-[var(--color-border)] bg-[var(--color-bg)] accent-[var(--color-accent)]"
              />
              <span>
                Public client (PKCE only — SPA / mobile)
              </span>
            </label>
          )}
        </div>
      )}

      {/* Language tabs */}
      <Tabs
        value={language}
        onValueChange={(v) => setLanguage(v as LanguageId)}
      >
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-0.5 rounded-none border-b border-[var(--color-border)] bg-[var(--color-bg)] p-1">
          {displayLanguages.map((l) => (
            <TabsTrigger
              key={l.id}
              value={l.id}
              className="rounded-[var(--radius-sm)] px-2.5 py-1 text-xs"
            >
              {l.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Code block — `relative` so the absolute copy chip pins to
       *  the code area's top-right rather than the whole card's
       *  top bar. The `group` class on the outer wrapper keeps the
       *  hover scope the entire card, so moving the cursor
       *  anywhere over the snippet reveals the copy button. */}
      <div className="relative">
        <CodeBlock code={code} language={highlight} />
        <SnippetCopyButton
          value={code}
          ariaLabel={`Copy ${meta?.label ?? ''} ${step} code`}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal — compact, hover-revealed copy button
// ---------------------------------------------------------------------------

/**
 * Theme-aware copy button that mirrors the look of
 * `CodeCopyButton` (used by MDX `<Pre>` blocks): 28×28 px square,
 * subtle muted border, hidden until the wrapping `.group` is
 * hovered or the button itself is keyboard-focused.
 *
 * Extracted instead of reusing `CodeCopyButton` because that
 * component walks the DOM to find a sibling `<pre>` — fine for
 * static MDX where the source lives in the rendered HTML, but
 * fragile in MultiLangSnippet where the visible code changes
 * with tab clicks.
 */
function SnippetCopyButton({
  value,
  ariaLabel,
}: {
  readonly value: string;
  readonly ariaLabel: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  async function handleCopy() {
    if (timeoutRef.current !== undefined) clearTimeout(timeoutRef.current);
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      // Older browsers / insecure contexts fall through to a
      // textarea-based copy so the button still works on localhost
      // over HTTP.
      try {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        setState('copied');
      } catch {
        setState('failed');
      }
    }
    timeoutRef.current = setTimeout(() => setState('idle'), 1500);
  }

  const icon =
    state === 'copied' ? (
      <Check className="h-3.5 w-3.5 text-[var(--color-success)]" aria-hidden="true" />
    ) : state === 'failed' ? (
      <X className="h-3.5 w-3.5 text-[var(--color-danger)]" aria-hidden="true" />
    ) : (
      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
    );

  const liveLabel =
    state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed to copy' : ariaLabel;

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      aria-label={liveLabel}
      title={liveLabel}
      className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] opacity-0 transition-all duration-[var(--duration-fast)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] focus-visible:opacity-100 group-hover:opacity-100"
    >
      {icon}
    </button>
  );
}
