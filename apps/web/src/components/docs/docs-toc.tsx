'use client';

/**
 * Docs table of contents, right-rail "On this page" navigator.
 *
 * Collapsible behaviour mirrors Stripe / Vercel / Linear docs:
 * the H2 whose section the reader is currently inside expands to
 * show its H3 / H4 descendants; every other H2 shows only its
 * label. Keeps the rail compact on long pages while still letting
 * you jump to any top-level section.
 *
 * The component is client-side because section tracking needs an
 * `IntersectionObserver` on the rendered headings.
 *
 * @module
 */

import { useEffect, useMemo, useRef, useState } from 'react';

export interface TocItem {
  readonly id: string;
  readonly title: string;
  readonly level: number; // 2 = h2, 3 = h3, 4 = h4
  readonly children: readonly TocItem[];
}

interface DocsTocProps {
  readonly items: readonly TocItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flatten the nested tree into an ordered `id` list for the observer. */
function flattenIds(items: readonly TocItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    ids.push(item.id);
    if (item.children.length > 0) ids.push(...flattenIds(item.children));
  }
  return ids;
}

/**
 * Map every descendant `id` back to the id of its top-level (H2)
 * ancestor so we can work out which section the reader is in when
 * an inner heading becomes active.
 */
function buildTopLevelIndex(items: readonly TocItem[]): Map<string, string> {
  const map = new Map<string, string>();
  function walk(nodes: readonly TocItem[], topId: string): void {
    for (const node of nodes) {
      map.set(node.id, topId);
      if (node.children.length > 0) walk(node.children, topId);
    }
  }
  for (const top of items) {
    map.set(top.id, top.id);
    if (top.children.length > 0) walk(top.children, top.id);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocsToc({ items }: DocsTocProps) {
  const [activeId, setActiveId] = useState<string>('');
  const observerRef = useRef<IntersectionObserver | null>(null);

  const topLevelIndex = useMemo(() => buildTopLevelIndex(items), [items]);

  useEffect(() => {
    const allIds = flattenIds(items);
    if (allIds.length === 0) return;

    // Track which headings are currently intersecting
    const visibleHeadings = new Map<string, IntersectionObserverEntry>();

    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleHeadings.set(entry.target.id, entry);
          } else {
            visibleHeadings.delete(entry.target.id);
          }
        }

        if (visibleHeadings.size > 0) {
          let topmost: string | null = null;
          let topY = Number.POSITIVE_INFINITY;
          for (const [id, entry] of visibleHeadings) {
            if (entry.boundingClientRect.top < topY) {
              topY = entry.boundingClientRect.top;
              topmost = id;
            }
          }
          if (topmost !== null) setActiveId(topmost);
        }
      },
      {
        // Fires when a heading crosses into the top 20% of the
        // viewport, feels right for a "what section am I in"
        // indicator without being jumpy.
        rootMargin: '0px 0px -80% 0px',
        threshold: 0,
      },
    );

    for (const id of allIds) {
      const el = document.getElementById(id);
      if (el !== null) observerRef.current.observe(el);
    }

    return () => observerRef.current?.disconnect();
  }, [items]);

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>, id: string): void {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el === null) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', `#${id}`);
    setActiveId(id);

    // `:target` doesn't always re-evaluate on `replaceState`-driven
    // hash changes (Safari notably lags), so we flip a data
    // attribute that the prose stylesheet animates via
    // `[data-flash="true"]`. Same keyframes as `:target`, just
    // triggered reliably from JS. Removed after the animation
    // duration so repeated clicks on the same anchor re-trigger.
    el.removeAttribute('data-flash');
    // Force a reflow so the re-set attribute re-plays the animation.
    void (el as HTMLElement).offsetWidth;
    el.setAttribute('data-flash', 'true');
    window.setTimeout(() => {
      if (el.getAttribute('data-flash') === 'true') el.removeAttribute('data-flash');
    }, 1700);
  }

  if (items.length === 0) return null;

  // Which top-level (H2) section is currently active? Falls back
  // to the first H2 so the rail has something expanded on initial
  // render before the observer fires.
  const activeTopLevelId = topLevelIndex.get(activeId) ?? items[0]?.id ?? '';

  return (
    <aside className="hidden w-56 shrink-0 lg:block">
      <nav
        aria-label="Table of contents"
        className="sticky top-[calc(3.5rem+1rem)] max-h-[calc(100vh-4.5rem)] overflow-y-auto pl-4"
      >
        <h4 className="mb-3 select-none text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-muted)]">
          On this page
        </h4>
        {/* The left rail is an overall thin divider; the active
         * top-level section paints a thicker accent segment over
         * its children below. Rendered per-entry, not here. */}
        <ul className="relative border-l border-[var(--color-border)]">
          {items.map((item) => (
            <TopLevelEntry
              key={item.id}
              item={item}
              activeId={activeId}
              isOpen={activeTopLevelId === item.id}
              onClick={handleClick}
            />
          ))}
        </ul>
      </nav>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Top-level (H2) entry, its children collapse when the section is not active.
// ---------------------------------------------------------------------------

interface TopLevelEntryProps {
  readonly item: TocItem;
  readonly activeId: string;
  readonly isOpen: boolean;
  readonly onClick: (e: React.MouseEvent<HTMLAnchorElement>, id: string) => void;
}

function TopLevelEntry({ item, activeId, isOpen, onClick }: TopLevelEntryProps) {
  const isActive = activeId === item.id;
  return (
    <li>
      <a
        href={`#${item.id}`}
        onClick={(e) => onClick(e, item.id)}
        aria-current={isActive ? 'true' : undefined}
        data-active={isActive}
        data-open={isOpen}
        className="group relative block py-[5px] pl-4 pr-2 text-[13px] leading-snug text-[var(--color-muted)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--color-fg)] data-[active=true]:font-medium data-[active=true]:text-[var(--color-fg)] data-[open=true]:text-[var(--color-fg)]"
      >
        {/* Accent rail, paints on the section's LEFT border when
         * the reader's inside this H2, so the collapsed-group idea
         * still has a strong "you are here" affordance. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-[-1px] top-0 h-full w-[2px] rounded-full bg-[var(--color-accent)] opacity-0 transition-opacity data-[open=true]:opacity-100 group-data-[open=true]:opacity-100"
          data-open={isOpen}
        />
        {item.title}
      </a>
      {isOpen && item.children.length > 0 && (
        // Inner accent-tinted rail, thinner + dimmer than the
        // outer one, so the nested children read as a "group under
        // the active H2" without competing with the main rail. The
        // line is drawn by a pseudo-element on the ::before of the
        // first li, positioned along the same left edge as the
        // child indentation.
        <ul className="relative mb-1 before:pointer-events-none before:absolute before:left-[15px] before:top-1 before:bottom-1 before:w-px before:bg-[var(--color-accent)]/25">
          {item.children.map((child) => (
            <ChildEntry key={child.id} item={child} activeId={activeId} onClick={onClick} />
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Nested (H3 / H4) entry, rendered only while its H2 parent is active.
// ---------------------------------------------------------------------------

interface ChildEntryProps {
  readonly item: TocItem;
  readonly activeId: string;
  readonly onClick: (e: React.MouseEvent<HTMLAnchorElement>, id: string) => void;
}

function ChildEntry({ item, activeId, onClick }: ChildEntryProps) {
  const isActive = activeId === item.id;
  const paddingClass = item.level === 3 ? 'pl-7' : 'pl-10';
  return (
    <li>
      <a
        href={`#${item.id}`}
        onClick={(e) => onClick(e, item.id)}
        aria-current={isActive ? 'true' : undefined}
        data-active={isActive}
        className={`relative block py-[5px] ${paddingClass} pr-2 text-[13px] leading-snug text-[var(--color-muted)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--color-fg)] data-[active=true]:font-medium data-[active=true]:text-[var(--color-accent)]`}
      >
        {/* Inner active-segment, 2px accent rail sitting on top of
         * the group's background rail at the same x-position
         * (left:15px). Mirrors the outer rail's pattern so the
         * active child reads just as clearly without adding a new
         * visual vocabulary. Rail is half the outer 2px segment's
         * height so it doesn't shout. */}
        <span
          aria-hidden="true"
          data-active={isActive}
          className="pointer-events-none absolute left-[14px] top-[5px] h-[calc(100%-10px)] w-[2px] rounded-full bg-[var(--color-accent)] opacity-0 transition-opacity data-[active=true]:opacity-100"
        />
        {item.title}
      </a>
      {item.children.length > 0 && (
        <ul>
          {item.children.map((child) => (
            <ChildEntry key={child.id} item={child} activeId={activeId} onClick={onClick} />
          ))}
        </ul>
      )}
    </li>
  );
}
