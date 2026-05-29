/**
 * Dynamic docs page -- renders MDX content from `src/content/docs/`.
 *
 * Handles both regular MDX documentation pages and the special
 * "API Reference" page that auto-generates endpoint cards from the
 * OpenAPI spec.
 *
 * @module
 */

import type { Metadata } from 'next';

import rehypeShiki from '@shikijs/rehype';
import { evaluate } from '@mdx-js/mdx';
import * as runtime from 'react/jsx-runtime';
import * as devRuntime from 'react/jsx-dev-runtime';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';

import { DocsSidebar } from '@/components/docs/docs-sidebar';
import { DocsToc } from '@/components/docs/docs-toc';
import { mdxComponents } from '@/components/docs/mdx-components';
import { remarkMermaid } from '@/lib/docs/remark-mermaid';
import {
  DOCS_NAV,
  DOC_CATEGORIES,
  extractToc,
  getAllDocSlugs,
  getDocNavItem,
  loadDoc,
} from '@/lib/docs';

import type { DocCategory, DocNavItem, TocItem } from '@/lib/docs';

import { ApiReferenceContent } from './api-reference-content';

// ---------------------------------------------------------------------------
// Static generation
// ---------------------------------------------------------------------------

export const dynamic = 'force-static';

export function generateStaticParams(): Array<{ slug: string[] }> {
  return getAllDocSlugs().map((slug) => ({
    slug: slug.split('/'),
  }));
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}): Promise<Metadata> {
  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');
  const navItem = getDocNavItem(slug);

  if (navItem === undefined) {
    return { title: 'Not Found' };
  }

  return {
    title: navItem.title,
    description: navItem.description,
    openGraph: {
      title: `${navItem.title} -- Crivacy Docs`,
      description: navItem.description,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the ordered flat list index for a given slug and return its
 * previous and next neighbours (if any).
 */
function getAdjacentPages(slug: string): {
  prev: DocNavItem | undefined;
  next: DocNavItem | undefined;
} {
  const idx = DOCS_NAV.findIndex((item) => item.slug === slug);
  if (idx === -1) return { prev: undefined, next: undefined };

  const prev: DocNavItem | undefined = idx > 0 ? DOCS_NAV[idx - 1] : undefined;
  const next: DocNavItem | undefined = idx < DOCS_NAV.length - 1 ? DOCS_NAV[idx + 1] : undefined;
  return { prev, next };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DocPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');

  // Look up the nav entry
  const navItem = getDocNavItem(slug);
  if (navItem === undefined) {
    notFound();
  }

  // Category metadata for breadcrumb
  const categoryMeta = DOC_CATEGORIES[navItem.category];

  // Previous / next for bottom nav
  const { prev, next } = getAdjacentPages(slug);

  // -----------------------------------------------------------------------
  // API Reference (auto-generated) branch
  // -----------------------------------------------------------------------
  if (navItem.isApiReference === true) {
    return (
      <DocsShell
        slug={slug}
        title={navItem.title}
        category={navItem.category}
        categoryLabel={categoryMeta.label}
        lastUpdated={undefined}
        toc={[]}
        prev={prev}
        next={next}
      >
        <ApiReferenceContent />
      </DocsShell>
    );
  }

  // -----------------------------------------------------------------------
  // Regular MDX branch
  // -----------------------------------------------------------------------
  const doc = loadDoc(slug);
  if (doc === null) {
    notFound();
  }

  const toc = extractToc(doc.content);

  // BUG #45 fix (2026-04-26): `next-mdx-remote/rsc::MDXRemote`
  // compiles MDX into a string and `Reflect.construct(Function, …)`-
  // evaluates it. React 19's dev mode rejects components produced
  // that way, the resulting `MDXContent` function never carries the
  // internal "development properties" marker React 19 stamps onto
  // SWC/Babel-transformed components, so every render bombs with
  // "Attempted to render <function MDXContent> without development
  // properties. This is not supported." → 500.
  //
  // `@mdx-js/mdx::evaluate` does the equivalent compile+eval but
  // takes the React jsx runtime (or jsx-dev-runtime) as an explicit
  // argument, so the resulting component is identical to one
  // produced by Next's own MDX loader and React 19 accepts it.
  const isDev = process.env['NODE_ENV'] !== 'production';
  const { default: MDXContent } = await evaluate(doc.content, {
    ...(isDev ? (devRuntime as unknown as typeof runtime) : runtime),
    development: isDev,
    remarkPlugins: [remarkGfm, remarkMermaid],
    rehypePlugins: [
      rehypeSlug,
      // `append` keeps the heading text plain and adds a hash anchor
      // AFTER it, avoids the prose-wide underline on every heading
      // that `behavior: 'wrap'` produces.
      [
        rehypeAutolinkHeadings,
        {
          behavior: 'append',
          properties: {
            className: ['heading-anchor'],
            'aria-label': 'Link to this section',
          },
        },
      ],
      // Dual-theme emits two themed blocks on each fence,
      // `github-light` on top, `github-dark` underneath. CSS hides
      // one of them based on `data-theme` so the code block retints
      // perfectly when the user flips theme without a full reload.
      [
        rehypeShiki,
        {
          themes: { light: 'github-light', dark: 'github-dark-default' },
          defaultColor: false,
        },
      ],
    ],
  });

  return (
    <DocsShell
      slug={slug}
      title={doc.frontmatter.title}
      category={navItem.category}
      categoryLabel={categoryMeta.label}
      lastUpdated={doc.frontmatter.lastUpdated}
      toc={toc}
      prev={prev}
      next={next}
    >
      <MDXContent components={mdxComponents} />
    </DocsShell>
  );
}

// ---------------------------------------------------------------------------
// Shell -- three-column layout used by both MDX and API-ref branches
// ---------------------------------------------------------------------------

interface DocsShellProps {
  readonly slug: string;
  readonly title: string;
  readonly category: DocCategory;
  readonly categoryLabel: string;
  readonly lastUpdated: string | undefined;
  readonly toc: readonly TocItem[];
  readonly prev: DocNavItem | undefined;
  readonly next: DocNavItem | undefined;
  readonly children: React.ReactNode;
}

function DocsShell({
  slug,
  title,
  categoryLabel,
  lastUpdated,
  toc,
  prev,
  next,
  children,
}: DocsShellProps) {
  return (
    <div className="flex w-full gap-8 py-8 lg:py-10">
      {/* ---------------------------------------------------------------- */}
      {/* Left sidebar                                                     */}
      {/* ---------------------------------------------------------------- */}
      <DocsSidebar currentSlug={slug} />

      {/* ---------------------------------------------------------------- */}
      {/* Center content                                                   */}
      {/* ---------------------------------------------------------------- */}
      <main className="min-w-0 flex-1">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="mb-4">
          <ol className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
            <li>
              <Link href="/docs" className="transition-colors hover:text-[var(--color-fg)]">
                Docs
              </Link>
            </li>
            <li aria-hidden="true" className="select-none">
              /
            </li>
            <li>
              <span className="text-[var(--color-muted)]">{categoryLabel}</span>
            </li>
            <li aria-hidden="true" className="select-none">
              /
            </li>
            <li>
              <span className="font-medium text-[var(--color-fg)]">{title}</span>
            </li>
          </ol>
        </nav>

        {/* Page heading */}
        <header className="mb-10 border-b border-[var(--color-border)] pb-6">
          <h1 className="text-[32px] font-semibold leading-tight tracking-tight text-[var(--color-fg)]">
            {title}
          </h1>
          {lastUpdated !== undefined && (
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              Last updated {lastUpdated}
            </p>
          )}
        </header>

        {/* Prose */}
        <article className="docs-prose max-w-none">{children}</article>

        {/* Previous / Next navigation */}
        <nav
          aria-label="Pagination"
          className="mt-14 flex items-stretch gap-4 border-t border-[var(--color-border)] pt-6"
        >
          {prev !== undefined ? (
            <Link
              href={`/docs/${prev.slug}`}
              className="hover:border-[var(--color-accent)]/40 group flex flex-1 flex-col items-start rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              <span className="text-xs text-[var(--color-muted)]">Previous</span>
              <span className="mt-1 text-sm font-medium text-[var(--color-fg)] transition-colors group-hover:text-[var(--color-accent)]">
                {prev.title}
              </span>
            </Link>
          ) : (
            <div className="flex-1" />
          )}

          {next !== undefined ? (
            <Link
              href={`/docs/${next.slug}`}
              className="hover:border-[var(--color-accent)]/40 group flex flex-1 flex-col items-end rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 text-right transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              <span className="text-xs text-[var(--color-muted)]">Next</span>
              <span className="mt-1 text-sm font-medium text-[var(--color-fg)] transition-colors group-hover:text-[var(--color-accent)]">
                {next.title}
              </span>
            </Link>
          ) : (
            <div className="flex-1" />
          )}
        </nav>
      </main>

      {/* ---------------------------------------------------------------- */}
      {/* Right table of contents                                          */}
      {/* ---------------------------------------------------------------- */}
      {toc.length > 0 && <DocsToc items={toc} />}
    </div>
  );
}
