'use client';

/**
 * Read-only syntax-highlighted code block. Calls the
 * `highlightCodeAction` server action on mount, injects the returned
 * dual-theme Shiki HTML via `dangerouslySetInnerHTML`. Browser never
 * imports Shiki nor compiles WebAssembly, Cat 33b's `'strict-dynamic'`
 * CSP stays intact (no `'wasm-unsafe-eval'` needed).
 *
 * **Cache.** Identical `(code, language)` pairs share one in-flight
 * Promise via a module-level Map keyed on `${language}\n${code}`.
 * Tab toggles between snippets the user already saw resolve
 * synchronously from cache, so there's no flash back to the plain
 * `<pre>` fallback when the user flips between SDK / HTTP variants.
 *
 * **Latency story.** First render of a given snippet pays one round-
 * trip to the SSR worker (~50ms warm, ~200ms cold while Shiki loads
 * grammars). Subsequent renders of the same snippet are
 * synchronous. Tab switching to a snippet not yet seen flashes the
 * plain-text fallback briefly, same UX the previous client-side
 * Shiki path produced for the very first highlight, so the change
 * is invisible to the docs / drawer / playground use cases.
 *
 * Output is always tokenised + escaped Shiki HTML; caller-supplied
 * `code` is never reflected as HTML, so `dangerouslySetInnerHTML`
 * is safe by construction.
 */

import { useEffect, useState } from 'react';

import { highlightCodeAction } from '@/lib/integration/highlight-action';
import { cn } from '@/lib/utils';

export type CodeBlockLanguage =
  | 'bash'
  | 'shell'
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'php'
  | 'java'
  | 'csharp'
  | 'go'
  | 'ruby'
  | 'json'
  | 'http';

/**
 * Module-level cache of `(language, code) → Promise<html|null>`. Any
 * two `<CodeBlock>` instances rendering the same snippet share one
 * server roundtrip. The keys never reach the wire, local map only.
 */
const cache = new Map<string, Promise<string | null>>();

function cacheKey(language: CodeBlockLanguage, code: string): string {
  return `${language}\n${code}`;
}

function getOrFetchHtml(
  language: CodeBlockLanguage,
  code: string,
): Promise<string | null> {
  const key = cacheKey(language, code);
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const promise = highlightCodeAction(code, language).catch(() => null);
  cache.set(key, promise);
  return promise;
}

/**
 * No-op kept for binary-compatibility with existing callers (e.g.
 * `dashboard/playground/page.tsx`). The previous client-side Shiki
 * implementation needed an explicit prewarm to overlap the grammar
 * bundle download with the rest of the UI; the server-action path
 * has no client-side bootstrap, so prewarm has nothing to do, but
 * we keep the export so nothing breaks at build time and so future
 * callers don't have to think about whether prewarming "matters".
 */
export function prewarmCodeBlockHighlighter(): void {
  // Intentionally empty.
}

export interface CodeBlockProps {
  code: string;
  language: CodeBlockLanguage;
  /**
   * Tailwind class appended to the outer `<div>`. The block sets its
   * own background + padding via the Shiki theme; anything visual
   * above that (border radius, max-height, etc.) is the caller's
   * responsibility.
   */
  className?: string;
}

export function CodeBlock({ code, language, className }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    void getOrFetchHtml(language, code).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (html !== null) {
    return (
      <div
        className={cn(
          // Shiki emits `<pre class="shiki shiki-themes ...">` with
          // CSS-variable colours; we just carry its container.
          '[&>pre]:m-0 [&>pre]:overflow-auto [&>pre]:rounded-[var(--radius-sm)] [&>pre]:p-4 [&>pre]:text-xs [&>pre]:leading-relaxed',
          className,
        )}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre
      className={cn(
        'm-0 overflow-auto rounded-[var(--radius-sm)] bg-[var(--color-bg)] p-4 font-mono text-xs leading-relaxed text-[var(--color-fg)]',
        className,
      )}
    >
      <code>{code}</code>
    </pre>
  );
}
