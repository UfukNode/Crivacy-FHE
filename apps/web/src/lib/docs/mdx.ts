/**
 * MDX content loader -- reads .mdx files from the content directory.
 *
 * Uses `gray-matter` to split frontmatter from the body. Returns raw
 * MDX content ready for `next-mdx-remote/rsc` to render.
 *
 * @module
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import matter from 'gray-matter';

// Content directory relative to apps/web/
const CONTENT_DIR = path.join(process.cwd(), 'src', 'content', 'docs');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocFrontmatter {
  readonly title: string;
  readonly description: string;
  readonly lastUpdated?: string | undefined;
}

export interface LoadedDoc {
  readonly slug: string;
  readonly frontmatter: DocFrontmatter;
  /** Raw MDX body without frontmatter. */
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a single doc by slug. Returns `null` if the file does not exist.
 *
 * @param slug       - filename without extension (e.g. `"getting-started"`)
 * @param contentDir - override the default content directory (useful for tests)
 */
export function loadDoc(slug: string, contentDir?: string | undefined): LoadedDoc | null {
  const dir = contentDir ?? CONTENT_DIR;
  const filePath = path.join(dir, `${slug}.mdx`);

  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);

  const frontmatter: DocFrontmatter = {
    title: typeof data['title'] === 'string' ? data['title'] : slug,
    description: typeof data['description'] === 'string' ? data['description'] : '',
    ...(typeof data['lastUpdated'] === 'string' ? { lastUpdated: data['lastUpdated'] } : {}),
  };

  return { slug, frontmatter, content };
}

/**
 * Load every `.mdx` file from the content directory.
 *
 * @param contentDir - override the default content directory (useful for tests)
 */
export function loadAllDocs(contentDir?: string | undefined): readonly LoadedDoc[] {
  const dir = contentDir ?? CONTENT_DIR;

  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mdx'));
  const docs: LoadedDoc[] = [];

  for (const file of files) {
    const slug = file.replace(/\.mdx$/, '');
    const doc = loadDoc(slug, dir);
    if (doc !== null) docs.push(doc);
  }

  return docs;
}
