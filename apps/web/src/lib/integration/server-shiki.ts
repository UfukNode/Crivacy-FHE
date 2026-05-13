/**
 * Server-side Shiki helper. Highlight code on the SSR worker, ship
 * static `<pre>` HTML to the browser. Browser never loads Shiki nor
 * compiles WebAssembly — Cat 33b's `'strict-dynamic'` CSP stays
 * intact (no `'wasm-unsafe-eval'` needed).
 *
 * Mirrors the dual-theme configuration used by the docs MDX
 * pipeline (`@shikijs/rehype` in `app/(docs)/docs/[...slug]/page.tsx`),
 * so a `<MultiLangSnippet>` on the docs page or in the dashboard
 * quickstart drawer retints exactly like a fenced ` ```bash ` block
 * in `.mdx` content under the same `[data-theme]` toggle.
 *
 * The highlighter is bootstrapped once per process and shared across
 * all callers via a module-level promise. First request pays the
 * grammar load (~150-200ms); subsequent requests are synchronous
 * tokenise + serialise.
 *
 * @module
 */

import 'server-only';

import type { Highlighter } from 'shiki';

/** Shared dual-theme config. Must match `code-block.tsx::THEMES`. */
const THEMES = { light: 'github-light', dark: 'github-dark-default' } as const;

/** Grammar bundle. Must be a superset of every language any caller
 *  in the app may ever request. */
const SUPPORTED_LANGUAGES = [
  'bash',
  'shell',
  'javascript',
  'typescript',
  'python',
  'php',
  'java',
  'csharp',
  'go',
  'ruby',
  'json',
  'http',
] as const;

export type ServerShikiLanguage = (typeof SUPPORTED_LANGUAGES)[number];

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise !== null) return highlighterPromise;
  highlighterPromise = (async () => {
    const shiki = await import('shiki');
    return shiki.createHighlighter({
      themes: [THEMES.light, THEMES.dark],
      langs: [...SUPPORTED_LANGUAGES],
    });
  })();
  return highlighterPromise;
}

/**
 * Render `code` as Shiki dual-theme HTML. Returns the same
 * `<pre class="shiki shiki-themes ...">` markup the docs MDX
 * pipeline emits, so the existing `globals.css` retint rules
 * (`:root[data-theme='light'] pre.shiki.shiki-themes ...`) cover it.
 *
 * Caller is responsible for wrapping the returned HTML in
 * `dangerouslySetInnerHTML` — Shiki output is tokenised + escaped,
 * never contains caller-supplied HTML, so injection-by-input is not
 * a vector here. Same shape `code-block.tsx` was already shipping.
 */
export async function highlightToHtml(
  code: string,
  language: ServerShikiLanguage,
): Promise<string> {
  const highlighter = await getHighlighter();
  return highlighter.codeToHtml(code, {
    lang: language,
    themes: THEMES,
    defaultColor: false,
  });
}
