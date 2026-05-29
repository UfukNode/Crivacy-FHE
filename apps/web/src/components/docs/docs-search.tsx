'use client';

/**
 * Docs search, command-palette style dialog that scores against
 * both the top-level page list and every `h2`/`h3` heading in
 * every MDX file.
 *
 * The index itself is built on the server (see
 * `@/lib/docs/search-index#buildDocsSearchIndex`) and handed to
 * this component as a prop so the client bundle never pays the
 * filesystem cost of reading MDX. Each entry carries a full
 * `href` of either `/docs/<slug>` or `/docs/<slug>#<anchor>`;
 * clicking the second form lands the reader on the matched
 * section, which is what the user flagged as missing in the
 * previous "search for 'scopes' → auth page opens at the top"
 * report.
 *
 * Opens with `Ctrl+K` / `Cmd+K`. Closes on Escape, the X button
 * in the input row, or any click on the backdrop outside the
 * dialog surface.
 *
 * @module
 */

import Link from 'next/link';
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DocsSearchEntry } from '@/lib/docs';

// Legacy alias, the dialog already uses `SearchableItem`
// extensively, so keep the name but re-shape it so it's a strict
// alias over the richer server-built index entry.
type SearchableItem = DocsSearchEntry;

// ---------------------------------------------------------------------------
// Naive search
// ---------------------------------------------------------------------------

function searchItems(
  index: readonly SearchableItem[],
  query: string,
): readonly SearchableItem[] {
  const lowerQuery = query.toLowerCase().trim();
  if (lowerQuery.length === 0) return [];

  const terms = lowerQuery.split(/\s+/);

  // Score each entry: exact title match > heading match > body hit.
  // Keeps "scopes" on the Authentication page as the top result
  // instead of getting buried under description matches.
  return index
    .map((item) => {
      const titleLc = item.title.toLowerCase();
      const itemWithBody = item as SearchableItem & { body?: string };
      const body = itemWithBody.body ?? '';
      // BUG #46/#47: include section-level MDX body in the haystack
      // so a term that lives only in prose (e.g. `disclosure_blob`,
      // `superseded`) still surfaces the matching section. Body
      // lives on `kind: 'section'` entries so the resolved href
      // carries the correct `#anchor`, page-level body matches
      // would land on the page top.
      const haystack = `${item.title} ${item.description} ${item.category} ${body}`.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return null;
      let score = 0;
      for (const term of terms) {
        if (titleLc === term) score += 100;
        else if (titleLc.startsWith(term)) score += 50;
        else if (titleLc.includes(term)) score += 25;
        // Headings (kind === 'section') are a better match for
        // intent-level queries like "scopes" or "webhook retry"
        // than a whole-page description, so nudge them up.
        if (item.kind === 'section' && titleLc.includes(term)) score += 10;
        // Body-only hit on a section entry, modest score so a
        // direct title/heading match for the same term still
        // outranks a body match, but the section surfaces above
        // a bare page entry without the term.
        if (
          item.kind === 'section' &&
          !titleLc.includes(term) &&
          body.includes(term)
        ) {
          score += 8;
        }
      }
      return { item, score };
    })
    .filter((r): r is { item: SearchableItem; score: number } => r !== null)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DocsSearchProps {
  /**
   * Full search index built on the server. When omitted the
   * dialog still renders but with an empty dataset, the layout
   * always passes a real index, but the prop is optional so the
   * component doesn't blow up in storybook-style renders.
   */
  readonly index?: readonly SearchableItem[];
}

export function DocsSearch({ index = [] }: DocsSearchProps = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // SSR guard, `createPortal` needs `document.body`, so defer the
  // portal mount to after hydration.
  useEffect(() => {
    setIsMounted(true);
  }, []);

  const results = useMemo(() => searchItems(index, query), [index, query]);

  // Clamp selected index when results change
  const resultsLength = results.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on result count change
  useEffect(() => {
    setSelectedIndex(0);
  }, [resultsLength]);

  // ---------------------------------------------------------------------------
  // Global keyboard shortcut
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    }
    document.addEventListener('keydown', handleGlobalKey);
    return () => document.removeEventListener('keydown', handleGlobalKey);
  }, []);

  // Focus input when dialog opens + lock background scroll so the
  // page underneath doesn't jitter while the modal is up.
  useEffect(() => {
    if (isOpen) {
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => {
        clearTimeout(t);
        document.body.style.overflow = previousOverflow;
      };
    }
    setQuery('');
    setSelectedIndex(0);
    return undefined;
  }, [isOpen]);

  // ---------------------------------------------------------------------------
  // Dialog keyboard navigation
  // ---------------------------------------------------------------------------

  const handleDialogKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : Math.max(results.length - 1, 0)));
        return;
      }

      if (e.key === 'Enter' && results.length > 0) {
        e.preventDefault();
        const selected = results[selectedIndex];
        if (selected) {
          setIsOpen(false);
          // Navigate programmatically. `href` already carries the
          // anchor (e.g. `/docs/authentication#scopes`) when the
          // match was on a section heading, so this one assignment
          // handles both page-level and section-level results.
          window.location.href = selected.href;
        }
      }
    },
    [results, selectedIndex],
  );

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-search-item]');
    const active = items[selectedIndex];
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-muted)] transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-muted)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
      >
        {/* Search icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
            clipRule="evenodd"
          />
        </svg>
        <span className="hidden sm:inline">Search docs...</span>
        <kbd className="ml-2 hidden rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)] sm:inline-block">
          {typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/.test(navigator.platform)
            ? '\u2318K'
            : 'Ctrl+K'}
        </kbd>
      </button>

      {isOpen && isMounted
        ? createPortal(
            <SearchDialog
              query={query}
              setQuery={setQuery}
              results={results}
              selectedIndex={selectedIndex}
              setSelectedIndex={setSelectedIndex}
              inputRef={inputRef}
              listRef={listRef}
              onClose={() => setIsOpen(false)}
              onKeyDown={handleDialogKey}
              index={index}
            />,
            document.body,
          )
        : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Dialog, extracted so the empty state, result groups, and footer
// stay readable and don't bloat the outer component's return.
// ---------------------------------------------------------------------------

interface SearchDialogProps {
  readonly query: string;
  readonly setQuery: (value: string) => void;
  readonly results: readonly SearchableItem[];
  readonly selectedIndex: number;
  readonly setSelectedIndex: (value: number) => void;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly listRef: React.RefObject<HTMLUListElement | null>;
  readonly onClose: () => void;
  readonly onKeyDown: (e: React.KeyboardEvent) => void;
  readonly index: readonly SearchableItem[];
}

function SearchDialog({
  query,
  setQuery,
  results,
  selectedIndex,
  setSelectedIndex,
  inputRef,
  listRef,
  onClose,
  onKeyDown,
  index,
}: SearchDialogProps) {
  const trimmed = query.trim();
  const isEmpty = trimmed.length === 0;

  // Compute suggestions by looking up real entries in the index.
  // When the requested slug isn't registered (e.g. a future rename)
  // we just skip it rather than rendering a broken link.
  const SUGGESTED_HREFS = [
    '/docs/getting-started',
    '/docs/oauth',
    '/docs/webhooks',
    '/docs/authentication',
  ];
  const suggestions = SUGGESTED_HREFS.flatMap((href) => {
    const match = index.find((item) => item.href === href && item.kind === 'page');
    return match !== undefined ? [match] : [];
  });

  // Results get grouped by category so the reader immediately sees
  // which category a matching page belongs to. Preserves the order
  // in which results were scored (first match wins placement).
  const groups = groupByCategory(results);

  // Single overlay wrapper + click delegation, this is the fix
  // for the "backdrop click doesn't close" bug. The inner
  // `<div>` stops propagation so a click on the dialog surface
  // itself never reaches the outer close handler, but anywhere
  // else on the overlay (the darkened area) triggers close.
  // Keyboard handling lives on the dialog element below.
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 pt-[12vh] pb-8 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search documentation"
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)]"
      >
        {/* Input row.
         * The `docs-search-field` class targets the input + chrome
         * buttons to opt them out of the global `:focus-visible`
         * outline rule in globals.css, a visible ring on a borderless
         * command-palette input looks amateur. Focus intent is still
         * conveyed by the cursor + the always-visible leading icon. */}
        <div className="flex items-center gap-4 border-b border-[var(--color-border)] px-5 py-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-5 w-5 shrink-0 text-[var(--color-muted)]"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
              clipRule="evenodd"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search guides, API reference, webhooks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="docs-search-field flex-1 border-0 bg-transparent p-0 text-[16px] leading-6 text-[var(--color-fg)] placeholder:text-[var(--color-muted)] focus:outline-none focus:ring-0"
            autoComplete="off"
            spellCheck={false}
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear query"
              className="docs-search-field inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] focus:outline-none"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M4.28 3.22a.75.75 0 0 0-1.06 1.06L8.94 10l-5.72 5.72a.75.75 0 1 0 1.06 1.06L10 11.06l5.72 5.72a.75.75 0 1 0 1.06-1.06L11.06 10l5.72-5.72a.75.75 0 0 0-1.06-1.06L10 8.94 4.28 3.22Z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
          {/* Dedicated close button, Esc + backdrop click both work,
           * but a visible X is the discoverability anchor most users
           * expect on a floating panel. */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="docs-search-field inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] focus:outline-none"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M4.28 3.22a.75.75 0 0 0-1.06 1.06L8.94 10l-5.72 5.72a.75.75 0 1 0 1.06 1.06L10 11.06l5.72 5.72a.75.75 0 1 0 1.06-1.06L11.06 10l5.72-5.72a.75.75 0 0 0-1.06-1.06L10 8.94 4.28 3.22Z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[60vh] overflow-y-auto px-2 py-2">
          {isEmpty ? (
            <div className="px-3 py-3">
              <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                Jump to
              </p>
              <ul className="space-y-0.5">
                {suggestions.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onClose}
                      className="flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-sm transition-colors hover:bg-[var(--color-surface-hover)]"
                    >
                      <CategoryIcon category={item.category} />
                      <span className="flex-1 font-medium text-[var(--color-fg)]">
                        {item.title}
                      </span>
                      <span className="text-[11px] text-[var(--color-muted)]">{item.category}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : results.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="text-sm text-[var(--color-fg)]">
                No results for{' '}
                <span className="font-medium">&ldquo;{trimmed}&rdquo;</span>.
              </p>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Try a broader keyword or browse the sidebar.
              </p>
            </div>
          ) : (
            <ul ref={listRef} className="space-y-4 py-1">
              {groups.map((group) => (
                <li key={group.category}>
                  <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                    {group.category}
                  </p>
                  <ul className="space-y-0.5">
                    {group.items.map(({ item, globalIndex }) => {
                      const isSelected = globalIndex === selectedIndex;
                      return (
                        <li key={item.href} data-search-item aria-selected={isSelected}>
                          <Link
                            href={item.href}
                            onClick={onClose}
                            onMouseEnter={() => setSelectedIndex(globalIndex)}
                            className={`flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 transition-colors ${
                              isSelected
                                ? 'bg-[var(--color-accent)]/10'
                                : 'hover:bg-[var(--color-surface-hover)]'
                            }`}
                          >
                            <CategoryIcon category={item.category} />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-sm font-medium text-[var(--color-fg)]">
                                  {item.title}
                                </span>
                                {item.kind === 'section' && (
                                  <span className="shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--color-muted)]">
                                    §
                                  </span>
                                )}
                              </span>
                              <span className="block truncate text-[11px] text-[var(--color-muted)]">
                                {item.description}
                              </span>
                            </span>
                            {isSelected && (
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 20 20"
                                fill="currentColor"
                                className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]"
                                aria-hidden="true"
                              >
                                <path
                                  fillRule="evenodd"
                                  d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
                                  clipRule="evenodd"
                                />
                              </svg>
                            )}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-4 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-2.5 text-[11px] text-[var(--color-muted)]">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            open
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>esc</Kbd>
            close
          </span>
          <span className="ml-auto">{results.length > 0 ? `${results.length} result${results.length === 1 ? '' : 's'}` : null}</span>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { readonly children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1 font-mono text-[10px] font-medium text-[var(--color-fg)]">
      {children}
    </kbd>
  );
}

function CategoryIcon({ category }: { readonly category: string }) {
  const lc = category.toLowerCase();
  // Very small icon set, a single "which group" pictogram is
  // enough to give the results list the visual grammar a plain
  // text list lacks.
  const path =
    lc.includes('overview') ||
    lc.includes('guide') ||
    lc.includes('getting')
      ? 'M4 6h16M4 12h16M4 18h7'
      : lc.includes('api')
        ? 'M7 8l-4 4 4 4m10-8l4 4-4 4M14 4l-4 16'
        : lc.includes('resource') || lc.includes('error') || lc.includes('rate')
          ? 'M4 7V4h16v3M9 20h6M12 4v16'
          : 'M9 12h6m-3-3v6m9-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z';
  return (
    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-bg)] text-[var(--color-muted)]">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.6}
        stroke="currentColor"
        className="h-3.5 w-3.5"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d={path} />
      </svg>
    </span>
  );
}

interface ResultGroup {
  readonly category: string;
  readonly items: ReadonlyArray<{
    readonly item: SearchableItem;
    readonly globalIndex: number;
  }>;
}

function groupByCategory(results: readonly SearchableItem[]): readonly ResultGroup[] {
  const byCategory = new Map<string, Array<{ item: SearchableItem; globalIndex: number }>>();
  results.forEach((item, globalIndex) => {
    const list = byCategory.get(item.category) ?? [];
    list.push({ item, globalIndex });
    byCategory.set(item.category, list);
  });
  const out: ResultGroup[] = [];
  for (const [category, items] of byCategory) {
    out.push({ category, items });
  }
  return out;
}
