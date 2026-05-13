'use server';

/**
 * Server action for `<CodeBlock>` syntax highlighting.
 *
 * Browser-side `<CodeBlock>` instances call this action to render
 * code via Shiki on the SSR worker, then inject the returned HTML
 * via `dangerouslySetInnerHTML`. The browser never imports Shiki
 * nor compiles WebAssembly — Cat 33b's `'strict-dynamic'` CSP
 * stays intact (no `'wasm-unsafe-eval'` needed).
 *
 * Server actions are framework-protected against CSRF (POST + same-
 * origin + action-ID-bound) and run on the same Node.js worker as
 * route handlers. The Shiki highlighter is bootstrapped once per
 * process (`server-shiki.ts` shared promise) so the per-call cost is
 * a synchronous tokenise + serialise after the first request.
 *
 * Input is restricted by `ServerShikiLanguage` (closed union); any
 * unexpected language string falls through to a safe `bash`
 * fallback. Code itself is never user-controlled HTML — Shiki output
 * is always tokenised + escaped, so caller-side
 * `dangerouslySetInnerHTML` is safe by construction.
 *
 * @module
 */

import { highlightToHtml, type ServerShikiLanguage } from './server-shiki';

const SUPPORTED: ReadonlySet<ServerShikiLanguage> = new Set([
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
]);

/** Hard cap on code size — defense against accidental DOS. Real
 *  snippets in this repo top out around 4-5 KB; 64 KB is comfortable
 *  headroom but still bounds the Shiki workload per call. */
const MAX_CODE_BYTES = 64 * 1024;

export async function highlightCodeAction(
  code: string,
  language: string,
): Promise<string | null> {
  if (typeof code !== 'string' || code.length === 0) return null;
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) return null;

  const lang: ServerShikiLanguage = SUPPORTED.has(language as ServerShikiLanguage)
    ? (language as ServerShikiLanguage)
    : 'bash';

  try {
    return await highlightToHtml(code, lang);
  } catch {
    // Grammar miss / theme mismatch — caller falls back to plain
    // <pre> so the snippet is still readable.
    return null;
  }
}
