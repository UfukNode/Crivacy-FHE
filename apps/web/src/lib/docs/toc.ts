/**
 * Table of contents extraction from MDX content.
 *
 * Extracts ATX-style headings (`## Heading`) and builds a nested tree.
 * Skips H1 because the page title comes from frontmatter.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TocItem {
  readonly id: string;
  readonly title: string;
  readonly level: number;
  readonly children: readonly TocItem[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract headings from an MDX content string.
 *
 * Only considers ATX-style headings (`## Heading` through `#### Heading`).
 * H1 is intentionally skipped -- the page title comes from frontmatter.
 */
export function extractToc(content: string): readonly TocItem[] {
  // Per-document collision counter that mirrors github-slugger
  // (used by rehype-slug): when the same slug would be emitted
  // twice, the second gets `-1`, the third `-2`, etc. Keeping the
  // same algorithm here is load-bearing — otherwise our TOC /
  // search anchor hashes drift away from the ids rehype-slug
  // actually stamps on the rendered `<h2>` / `<h3>` elements.
  const seen = new Map<string, number>();
  const flat: Array<{ id: string; title: string; level: number; offset: number }> = [];

  // ATX-style markdown headings (`## Heading`, `### Heading`, `#### Heading`).
  const atxRegex = /^(#{2,4})\s+(.+)$/gm;
  let match = atxRegex.exec(content);
  while (match !== null) {
    const level = match[1]?.length ?? 2;
    const title = (match[2] ?? '').trim();
    const base = slugify(title);
    const count = seen.get(base) ?? 0;
    const id = count === 0 ? base : `${base}-${count}`;
    seen.set(base, count + 1);
    flat.push({ id, title, level, offset: match.index });
    match = atxRegex.exec(content);
  }

  // HTML headings with explicit `id` attribute — authors reach for
  // these when they need a stable slug that `rehype-slug` wouldn't
  // generate cleanly (e.g. `credential.created` where dots get
  // stripped and collapsed into `credentialcreated`). The MDX
  // pipeline renders `<h3 id="…">…</h3>` verbatim, so we mirror
  // them in the TOC by scanning the raw source. Only `h2` / `h3` /
  // `h4` participate; anything else stays ignored to match the
  // ATX branch.
  const htmlRegex = /<h([234])\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/h\1>/gi;
  match = htmlRegex.exec(content);
  while (match !== null) {
    const level = Number.parseInt(match[1] ?? '2', 10);
    const id = match[2] ?? '';
    // Strip any inline markup / code fences (``code``) so the TOC
    // shows plain text. The content between the tags can contain
    // arbitrary MDX; a cheap strip is enough here.
    const rawTitle = (match[3] ?? '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (id.length > 0 && rawTitle.length > 0) {
      flat.push({ id, title: rawTitle, level, offset: match.index });
    }
    match = htmlRegex.exec(content);
  }

  // Interleave both sources by their position in the source file
  // so the nesting builder sees headings in document order.
  flat.sort((a, b) => a.offset - b.offset);

  return buildTocTree(flat.map(({ id, title, level }) => ({ id, title, level })));
}

/**
 * Convert heading text to a URL-friendly slug.
 * Matches rehype-slug's default behaviour.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Build a nested TOC tree from a flat heading list.
 *
 * Each heading becomes a child of the most recent heading with a strictly
 * lower level, producing a natural nesting (H2 > H3 > H4).
 */
function buildTocTree(
  flat: ReadonlyArray<{ id: string; title: string; level: number }>,
): readonly TocItem[] {
  const root: TocItem[] = [];
  const stack: Array<{ item: TocItem; level: number }> = [];

  for (const heading of flat) {
    const item: TocItem = {
      id: heading.id,
      title: heading.title,
      level: heading.level,
      children: [],
    };

    // Pop stack until we find a parent with a lower level
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined || top.level < heading.level) break;
      stack.pop();
    }

    const parent = stack.length > 0 ? stack[stack.length - 1] : undefined;
    if (parent === undefined) {
      root.push(item);
    } else {
      // Attach as child of the last stack entry
      (parent.item.children as TocItem[]).push(item);
    }

    stack.push({ item, level: heading.level });
  }

  return root;
}
