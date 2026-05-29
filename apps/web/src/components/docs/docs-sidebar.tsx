/**
 * Docs sidebar, category tree navigation for the documentation site.
 * Server component, no client-side state.
 *
 * The navigation tree is derived from `lib/docs/config.ts` via
 * `getSidebarTree()`. That module is the single source of truth,
 * every slug in the sidebar resolves to a registered `DOCS_NAV`
 * entry, which in turn resolves to an MDX file on disk or the
 * auto-generated API reference page. Inlining a second copy of the
 * nav tree here (the previous approach) let the sidebar drift ahead
 * of the MDX filesystem and produced six dead links at once.
 *
 * Add new pages by registering them in `config.ts`; the sidebar,
 * breadcrumbs, and search dialog pick them up automatically.
 *
 * @module
 */

import Link from 'next/link';

// Import directly from `config` instead of the barrel, the barrel
// re-exports `mdx.ts`, which pulls in `node:path` for filesystem
// reads. Anything that drags this file into a client bundle (e.g.
// the mobile drawer) would otherwise fail webpack with an
// "Unhandled scheme" on `node:`. `config.ts` is pure data and
// safe to ship to both server and client surfaces.
import { getSidebarTree } from '@/lib/docs/config';

interface SidebarProps {
  readonly currentSlug: string;
  /**
   * When rendered inside the mobile drawer we want the tree to
   * stretch to the full drawer height instead of carrying its own
   * `sticky` positioning (which doesn't mean anything inside a
   * modal). The desktop shell keeps the sticky layout.
   */
  readonly variant?: 'desktop' | 'mobile';
}

export function DocsSidebar({ currentSlug, variant = 'desktop' }: SidebarProps) {
  const tree = getSidebarTree();
  const tree_content = (
    <nav
      aria-label="Documentation navigation"
      className={
        variant === 'desktop'
          ? // Sticky offset matches the fixed docs header height
            // (3.5rem) plus a 1rem breathing gap so the sidebar
            // starts just under the header instead of sliding
            // behind it when the reader scrolls down.
            'scrollbar-thin scrollbar-thumb-[var(--color-border)] scrollbar-track-transparent sticky top-[calc(3.5rem+1rem)] max-h-[calc(100vh-4.5rem)] overflow-y-auto pb-10 pr-4'
          : 'flex h-full flex-col overflow-y-auto pb-10 pr-4'
      }
    >
      <ul className="space-y-6">
        {tree.map(({ category, items }) => (
          <li key={category.key}>
            <h3 className="mb-2 select-none px-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-muted)]">
              {category.label}
            </h3>

            <ul className="space-y-0.5">
              {items.map((item) => {
                const isActive = currentSlug === item.slug;
                return (
                  <li key={item.slug}>
                    <Link
                      href={`/docs/${item.slug}`}
                      aria-current={isActive ? 'page' : undefined}
                      className={`relative block rounded-[var(--radius-md)] px-3 py-1.5 text-[13.5px] leading-snug transition-colors duration-[var(--duration-fast)] ${
                        isActive
                          ? 'bg-[var(--color-accent)]/10 font-medium text-[var(--color-accent)]'
                          : 'text-[var(--color-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
                      } focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]`}
                    >
                      {item.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
  if (variant === 'mobile') return tree_content;
  return <aside className="hidden w-64 shrink-0 md:block">{tree_content}</aside>;
}
