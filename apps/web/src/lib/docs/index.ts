/**
 * Docs library -- MDX loading, navigation, TOC, OpenAPI reference.
 *
 * Consumers should import from this module (`@/lib/docs`) rather than
 * reaching into individual files. The barrel re-exports every type,
 * constant, and function that belongs to the public contract.
 *
 * Layering:
 *
 *   * `config`      -- sidebar navigation tree & category metadata
 *   * `mdx`         -- frontmatter parsing & .mdx file loading
 *   * `toc`         -- table of contents extraction from MDX headings
 *   * `openapi-ref` -- OpenAPI spec parser for the API reference page
 *
 * @module
 */

export type { DocCategory, DocCategoryMeta, DocNavItem } from './config';
export {
  DOC_CATEGORIES,
  DOCS_NAV,
  getAllDocSlugs,
  getDocNavItem,
  getDocsByCategory,
  getSidebarTree,
} from './config';

export type { DocFrontmatter, LoadedDoc } from './mdx';
export { loadAllDocs, loadDoc } from './mdx';

export type { TocItem } from './toc';
export { extractToc, slugify } from './toc';

export type { ApiEndpoint, ApiParameter, ApiRequestBody, ApiTagGroup } from './openapi-ref';
export { loadApiReference } from './openapi-ref';

export type { DocsSearchEntry } from './search-index';
export { buildDocsSearchIndex } from './search-index';
