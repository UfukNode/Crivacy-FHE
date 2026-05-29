/**
 * Minimal inline-markdown renderer for short strings that arrive
 * from the OpenAPI spec (parameter descriptions, response blurbs,
 * error-code entries, etc.).
 *
 * Full CommonMark would be overkill, the only tokens that
 * regularly appear in these strings are:
 *
 *   * `` `code` ``, field names, literal enum values, regex bits
 *   * `**bold**`, occasional emphasis on a keyword
 *
 * Rendering them verbatim produces the "amateur docs site" look
 * the user flagged, where `validation_failed`, `YYYY-MM-DD…`, and
 * `[1, 100]` come through as plain unstyled prose instead of the
 * distinct monospace pills every professional API docs surface
 * (Stripe, Auth0, Supabase, …) uses.
 *
 * The parser is intentionally dumb-simple: a single regex pass that
 * recognises the two token kinds, otherwise emits plain text. No
 * nesting, no escaping, no sanitisation required because the input
 * is trusted (it's OUR OpenAPI spec, not user-submitted content).
 *
 * @module
 */

import type { ComponentPropsWithoutRef, ReactNode } from 'react';

export interface MarkdownTextProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  readonly children: string | null | undefined;
}

// A single regex that finds either a backtick span or a double-star
// bold span. Order matters: `backtick` is evaluated first so a
// literal `**` inside code is not mistaken for bold.
const TOKEN_RE = /`([^`]+)`|\*\*([^*]+)\*\*/g;

export function MarkdownText({ children, className, ...rest }: MarkdownTextProps) {
  if (children === null || children === undefined || children.length === 0) {
    return null;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let keyIdx = 0;
  for (const match of children.matchAll(TOKEN_RE)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > cursor) {
      nodes.push(children.slice(cursor, matchIndex));
    }
    const [full, codeText, boldText] = match;
    if (codeText !== undefined) {
      nodes.push(
        <code
          key={`md-c-${keyIdx++}`}
          className="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 font-mono text-[0.9em] text-[var(--color-fg)]"
        >
          {codeText}
        </code>,
      );
    } else if (boldText !== undefined) {
      nodes.push(
        <strong key={`md-b-${keyIdx++}`} className="font-semibold text-[var(--color-fg)]">
          {boldText}
        </strong>,
      );
    }
    cursor = matchIndex + full.length;
  }
  if (cursor < children.length) {
    nodes.push(children.slice(cursor));
  }

  return (
    <span className={className} {...rest}>
      {nodes}
    </span>
  );
}
