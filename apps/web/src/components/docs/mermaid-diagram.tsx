'use client';

/**
 * Client-side Mermaid renderer for MDX fences tagged ```mermaid.
 *
 * Mermaid is a ~500 KB bundle so we only load it on pages that
 * actually render a diagram.
 *
 * Design notes:
 *   1. `mermaid.initialize` is called **once** per (theme, page)
 *      pair. Re-initialising on every render races with any
 *      `render` call still in flight and leaves the internal
 *      `siteConfig` half-mutated, at which point Mermaid throws
 *      `Cannot read properties of undefined (reading 'replace')`.
 *   2. Theme changes are handled by invalidating the load promise
 *      and re-importing, paying the dynamic-import cost on a
 *      manual theme toggle is acceptable vs. the reliability
 *      tradeoff of mutating global config mid-render.
 *   3. Render operations are serialised through a module-level
 *      promise chain, Mermaid v11 doesn't guarantee concurrent
 *      `render()` calls are safe, and we've seen `id` collisions
 *      when two diagrams on the same page hydrate together.
 *
 * The component degrades gracefully when Mermaid fails: an
 * inline warning banner + a `<details>` showing the source, so
 * the page still carries the information even if the fancy
 * rendering didn't land.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Mermaid as MermaidApi, MermaidConfig } from 'mermaid';

import { MermaidLightbox } from './mermaid-lightbox';

export interface MermaidDiagramProps {
  /**
   * Mermaid source. Always arrives as a string attribute because
   * `remark-mermaid` rewrites ```mermaid fenced code blocks into
   * `<Mermaid code="…">` before the RSC compile pass, the only
   * shape that round-trips the RSC serialiser reliably for our
   * multi-line diagrams.
   */
  readonly code: string;
  /** Optional accessible caption shown under the rendered diagram. */
  readonly caption?: string;
}

type RenderState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'rendered'; readonly svg: string }
  | { readonly kind: 'error'; readonly message: string };

function readTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark';
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' ? 'light' : 'dark';
}

function mermaidConfigFor(theme: 'light' | 'dark'): MermaidConfig {
  const base: MermaidConfig = {
    startOnLoad: false,
    securityLevel: 'strict',
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
  };
  // Mermaid v11 sequence-diagram theme vars beyond `lineColor` and
  // `actorBkg` need to be set explicitly, without them the message
  // label text + sequence-number circles + loop labels fall back to
  // a near-white fill that disappears against the surface card on
  // light backgrounds. The light + dark blocks below pin every
  // sequence-specific colour the spec exposes so the diagram reads
  // cleanly in either theme.
  if (theme === 'light') {
    return {
      ...base,
      theme: 'default',
      themeVariables: {
        primaryColor: '#ecfdf5',
        primaryTextColor: '#064e3b',
        primaryBorderColor: '#10b981',
        lineColor: '#475569',
        textColor: '#0f172a',
        actorBkg: '#064e3b',
        actorBorder: '#10b981',
        actorTextColor: '#ffffff',
        actorLineColor: '#cbd5e1',
        signalColor: '#475569',
        signalTextColor: '#0f172a',
        labelBoxBkgColor: '#ecfdf5',
        labelBoxBorderColor: '#10b981',
        labelTextColor: '#064e3b',
        loopTextColor: '#0f172a',
        sequenceNumberColor: '#0f172a',
        noteBkgColor: '#fef3c7',
        noteBorderColor: '#f59e0b',
        noteTextColor: '#78350f',
        background: '#ffffff',
      },
    };
  }
  return {
    ...base,
    theme: 'dark',
    themeVariables: {
      primaryColor: '#064e3b',
      primaryTextColor: '#d1fae5',
      primaryBorderColor: '#10b981',
      lineColor: '#a1a1aa',
      textColor: '#e4e4e7',
      actorBkg: '#064e3b',
      actorBorder: '#10b981',
      actorTextColor: '#ecfdf5',
      actorLineColor: '#52525b',
      signalColor: '#a1a1aa',
      signalTextColor: '#e4e4e7',
      labelBoxBkgColor: '#064e3b',
      labelBoxBorderColor: '#10b981',
      labelTextColor: '#d1fae5',
      loopTextColor: '#e4e4e7',
      sequenceNumberColor: '#09090b',
      noteBkgColor: '#422006',
      noteBorderColor: '#f59e0b',
      noteTextColor: '#fde68a',
      background: '#09090b',
    },
  };
}

/**
 * Load + initialise Mermaid. Keyed by theme so each theme change
 * gets a fresh init, but concurrent diagram mounts on the same
 * theme share a single initialisation.
 */
let mermaidModule: MermaidApi | null = null;
let initialisedTheme: 'light' | 'dark' | null = null;
let initPromise: Promise<MermaidApi> | null = null;
function loadMermaid(theme: 'light' | 'dark'): Promise<MermaidApi> {
  if (mermaidModule !== null && initialisedTheme === theme) {
    return Promise.resolve(mermaidModule);
  }
  if (initPromise !== null && initialisedTheme === theme) {
    return initPromise;
  }
  initPromise = (async (): Promise<MermaidApi> => {
    const mod = mermaidModule ?? (await import('mermaid')).default;
    mermaidModule = mod;
    mod.initialize(mermaidConfigFor(theme));
    initialisedTheme = theme;
    return mod;
  })();
  return initPromise;
}

/**
 * Serialised render queue. Mermaid v11 has occasional internal
 * races between concurrent `render` calls (notably when two
 * diagrams on the same page hydrate at once), chaining awaits
 * through a single promise is the simplest fix.
 */
let renderChain: Promise<unknown> = Promise.resolve();
function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const next = renderChain.then(task, task);
  renderChain = next.catch(() => undefined);
  return next;
}

function makeId(): string {
  // Mermaid ids must be a valid CSS selector / DOM id, ensure we
  // start with a letter and use only `[A-Za-z0-9_-]`. `randomUUID`
  // starts with a hex char which is sometimes a digit; the leading
  // "mermaid-" prefix keeps us alphabetic.
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
  return `mermaid-${rand.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

export function MermaidDiagram({ code, caption }: MermaidDiagramProps) {
  const [state, setState] = useState<RenderState>({ kind: 'idle' });
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const diagramId = useMemo(makeId, []);

  // Track active theme so the diagram retints on toggle. No
  // state leak: the observer is per-instance and disconnects on
  // unmount.
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;

    enqueueRender(async () => {
      try {
        if (typeof code !== 'string' || code.length === 0) {
          throw new Error('Mermaid source was empty.');
        }
        const mermaid = await loadMermaid(theme);
        if (cancelled) return;
        // Fresh id per render so Mermaid's internal registry
        // never collides across re-renders of the same component
        // (e.g. on theme flip).
        const renderId = `${diagramId}-${theme}`;
        const { svg } = await mermaid.render(renderId, code);
        if (!cancelled) setState({ kind: 'rendered', svg });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message:
              err instanceof Error && err.message.length > 0
                ? err.message
                : 'Unknown render error.',
          });
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [code, theme, diagramId]);

  if (state.kind === 'error') {
    return (
      <div
        role="alert"
        className="my-5 rounded-[var(--radius-md)] border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 p-4 text-sm"
      >
        <p className="mb-2 font-semibold text-[var(--color-danger)]">
          Diagram failed to render
        </p>
        <pre className="overflow-x-auto text-xs text-[var(--color-muted)]">
          {state.message}
        </pre>
        <details className="mt-2 text-xs text-[var(--color-muted)]">
          <summary className="cursor-pointer">Show source</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre">{code}</pre>
        </details>
      </div>
    );
  }

  return (
    <>
      <figure className="group relative my-6 flex flex-col items-center gap-3 overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        {state.kind === 'rendered' ? (
          <>
            <button
              type="button"
              onClick={() => setIsLightboxOpen(true)}
              aria-label="Open diagram fullscreen"
              title="Open fullscreen (zoom & pan)"
              className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-bg)]/90 text-[var(--color-muted)] opacity-0 transition-opacity duration-[var(--duration-fast)] hover:text-[var(--color-fg)] group-hover:opacity-100 focus-visible:opacity-100"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-3.5 w-3.5"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M3.22 3.22a.75.75 0 0 1 1.06 0L7 5.94V4.75a.75.75 0 0 1 1.5 0v3a.75.75 0 0 1-.75.75h-3a.75.75 0 0 1 0-1.5h1.19L3.22 4.28a.75.75 0 0 1 0-1.06Zm13.56 0a.75.75 0 0 1 0 1.06L14.06 7h1.19a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1-.75-.75v-3a.75.75 0 0 1 1.5 0v1.19l2.72-2.72a.75.75 0 0 1 1.06 0ZM7.75 11.75a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-1.19l-2.72 2.72a.75.75 0 1 1-1.06-1.06L5.94 13H4.75a.75.75 0 0 1 0-1.5h3Zm4.5 0h3a.75.75 0 0 1 0 1.5h-1.19l2.72 2.72a.75.75 0 1 1-1.06 1.06L13 14.06v1.19a.75.75 0 0 1-1.5 0v-3a.75.75 0 0 1 .75-.75Z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            <div
              className="max-w-full [&_svg]:h-auto [&_svg]:max-w-full"
              // Mermaid SVG, generated with `securityLevel: 'strict'`
              // so user input stays escaped. Safe to inject.
              dangerouslySetInnerHTML={{ __html: state.svg }}
            />
          </>
        ) : (
          <pre className="overflow-x-auto text-xs text-[var(--color-muted)]">{code}</pre>
        )}
        {caption !== undefined && (
          <figcaption className="text-xs text-[var(--color-muted)]">{caption}</figcaption>
        )}
      </figure>
      {isLightboxOpen && state.kind === 'rendered' && (
        <MermaidLightbox
          svg={state.svg}
          {...(caption !== undefined ? { caption } : {})}
          onClose={() => setIsLightboxOpen(false)}
        />
      )}
    </>
  );
}
