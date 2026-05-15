/**
 * Docs search index builder.
 *
 * Runs at module-load on the server (layout + page components
 * are server-only in the App Router model). For every registered
 * doc we emit:
 *
 *   * One "page" entry — the top-level slug, rendered with the
 *     doc's title + description.
 *   * One "section" entry per `h2` / `h3` inside the MDX, with
 *     the heading id as the anchor hash so a click from the
 *     search dialog lands the reader on the matched section.
 *     Section entries also carry a flattened `body` slice — the
 *     prose between this heading and the next — so a query that
 *     matches body-only text (e.g. `disclosure_blob`) still
 *     resolves to the correct anchor instead of the page top.
 *
 * The resulting array is serialisable — the layout forwards it to
 * the `<DocsSearch>` client component via props, so the client
 * bundle never pays the filesystem cost of reading MDX.
 *
 * @module
 */

import { DOC_CATEGORIES, DOCS_NAV } from './config';
import { loadAllDocs } from './mdx';
import { slugify } from './toc';

export interface DocsSearchEntry {
  /** `<slug>` on its own for page entries, `<slug>#<anchor>` for headings. */
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  /** `'page'` or `'section'` — UI can tint the icon differently. */
  readonly kind: 'page' | 'section';
  /** Parent-page title when `kind === 'section'` so the dialog can show `Page → Section`. */
  readonly parentTitle?: string;
  /**
   * Lowercased prose under this section heading (section entries
   * only). Code fences, MDX directives, and HTML tags stripped.
   * Lets a body-only term like `disclosure_blob` or `superseded`
   * surface the right anchor instead of the page top.
   * BUG #46/#47 (2026-04-26): page-level body indexing landed in
   * #46 but routed all body matches to the page top — moved to
   * per-section slices in #47 so anchor links resolve correctly.
   */
  readonly body?: string;
}

/**
 * Strip MDX body to lowercased prose. Removes:
 *  - Front-matter (already excluded upstream)
 *  - Code fences ``` … ```
 *  - HTML tags `<x>…</x>`
 *  - JSX import/export statements at top of file
 *  - Markdown link/image syntax noise (keeps the visible text)
 *  - Repeated whitespace
 */
function flattenBodyForSearch(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^import .*?;?$/gm, ' ')
    .replace(/^export .*?;?$/gm, ' ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_~>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

interface HeadingPosition {
  readonly id: string;
  readonly title: string;
  readonly level: number;
  /** Source offset where the heading line begins. */
  readonly offset: number;
  /** Source offset where the heading line ends — body starts here. */
  readonly bodyStart: number;
}

/**
 * Locate every `h2` / `h3` heading in the MDX source along with the
 * source offsets needed to slice its body (everything up to the
 * next heading of any level). Mirrors `extractToc`'s slug algorithm
 * so the anchor hash on a section entry round-trips to the id
 * `rehype-slug` actually stamps on the rendered element.
 *
 * Both ATX (`## Heading`) and explicit-id HTML headings
 * (`<h3 id="…">…</h3>`) participate, with HTML headings winning
 * over ATX when they collide on the same offset (they don't in
 * practice, but the sort guarantees stable ordering).
 */
function extractSectionsForIndex(content: string): readonly HeadingPosition[] {
  const seen = new Map<string, number>();
  // We collect *every* heading (h2-h4) so the body slice for an
  // h3 can be bounded by the next h4 even though we don't surface
  // h4s themselves. Filtering happens at the very end.
  const flat: HeadingPosition[] = [];

  const atxRegex = /^(#{2,4})\s+(.+)$/gm;
  let m = atxRegex.exec(content);
  while (m !== null) {
    const level = m[1]?.length ?? 2;
    const title = (m[2] ?? '').trim();
    const base = slugify(title);
    const count = seen.get(base) ?? 0;
    const id = count === 0 ? base : `${base}-${count}`;
    seen.set(base, count + 1);
    flat.push({
      id,
      title,
      level,
      offset: m.index,
      bodyStart: m.index + m[0].length,
    });
    m = atxRegex.exec(content);
  }

  // Explicit-id HTML headings — authors reach for these when they
  // need a stable slug `rehype-slug` wouldn't generate cleanly
  // (e.g. `credential.created` — dots get stripped). Mirroring
  // `extractToc`'s second pass keeps section body slices correctly
  // partitioned in webhooks.mdx and oauth.mdx.
  const htmlRegex = /<h([234])\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/h\1>/gi;
  m = htmlRegex.exec(content);
  while (m !== null) {
    const level = Number.parseInt(m[1] ?? '2', 10);
    const id = m[2] ?? '';
    const rawTitle = (m[3] ?? '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (id.length > 0 && rawTitle.length > 0) {
      flat.push({
        id,
        title: rawTitle,
        level,
        offset: m.index,
        bodyStart: m.index + m[0].length,
      });
    }
    m = htmlRegex.exec(content);
  }

  flat.sort((a, b) => a.offset - b.offset);

  // Only h2/h3 surface in the search dialog — h4 is too granular
  // and would flood the index without adding navigation value.
  return flat.filter((h) => h.level <= 3);
}

/**
 * Build the full docs search index. Evaluated on the server at
 * component-render time; the output is plain data and re-usable.
 */
export function buildDocsSearchIndex(): readonly DocsSearchEntry[] {
  const entries: DocsSearchEntry[] = [];
  const docsBySlug = new Map<string, Awaited<ReturnType<typeof loadAllDocs>>[number]>();
  for (const doc of loadAllDocs()) {
    docsBySlug.set(doc.slug, doc);
  }

  for (const nav of DOCS_NAV) {
    const categoryLabel = DOC_CATEGORIES[nav.category].label;

    // Page-level entry — title/description/category only. Body
    // matches now live on per-section entries (see below) so a
    // hit lands on the matching anchor rather than the page top.
    entries.push({
      href: `/docs/${nav.slug}`,
      title: nav.title,
      description: nav.description,
      category: categoryLabel,
      kind: 'page',
    });

    const doc = docsBySlug.get(nav.slug);
    if (doc === undefined) continue;

    // Section entries with per-section body. Re-walk every heading
    // (h2-h4) so an h3 body is bounded by the next h4 even though
    // we don't emit the h4 itself.
    const sections = extractSectionsForIndex(doc.content);
    // We need *all* heading offsets (incl. h4) to compute correct
    // body end-positions. Re-run the same regex pass with no
    // level filter for the slicing logic.
    const allOffsets = collectAllHeadingOffsets(doc.content).sort((a, b) => a - b);
    for (const section of sections) {
      const nextOffset = allOffsets.find((off) => off > section.offset);
      const bodyEnd = nextOffset ?? doc.content.length;
      const slice = doc.content.slice(section.bodyStart, bodyEnd);
      entries.push({
        href: `/docs/${nav.slug}#${section.id}`,
        title: section.title,
        description: `${nav.title} — ${categoryLabel}`,
        category: categoryLabel,
        kind: 'section',
        parentTitle: nav.title,
        body: flattenBodyForSearch(slice),
      });
    }
  }
  return entries;
}

/**
 * Return every h2-h4 source offset (ATX + HTML) so a section body
 * slice can be bounded by the next heading of *any* level — an
 * h3's body must end at a sibling h4 even though h4s are filtered
 * out of the visible index.
 */
function collectAllHeadingOffsets(content: string): number[] {
  const offsets: number[] = [];
  const atxRegex = /^(#{2,4})\s+.+$/gm;
  let m = atxRegex.exec(content);
  while (m !== null) {
    offsets.push(m.index);
    m = atxRegex.exec(content);
  }
  const htmlRegex = /<h[234]\b[^>]*\bid=["'][^"']+["'][^>]*>[\s\S]*?<\/h[234]>/gi;
  m = htmlRegex.exec(content);
  while (m !== null) {
    offsets.push(m.index);
    m = htmlRegex.exec(content);
  }
  return offsets;
}
