/**
 * Docs navigation configuration -- single source of truth for sidebar tree.
 * @module
 */

// ---------------------------------------------------------------------------
// Category definitions
// ---------------------------------------------------------------------------

export type DocCategory = 'overview' | 'guides' | 'api-reference' | 'resources';

export interface DocNavItem {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly category: DocCategory;
  readonly order: number;
  /** If true, this is the API reference auto-generated page. */
  readonly isApiReference?: boolean | undefined;
}

export interface DocCategoryMeta {
  readonly label: string;
  readonly order: number;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Category metadata
// ---------------------------------------------------------------------------

export const DOC_CATEGORIES: Record<DocCategory, DocCategoryMeta> = Object.freeze({
  overview: { label: 'Overview', order: 0, description: 'Introduction and quick start' },
  guides: { label: 'Guides', order: 1, description: 'In-depth integration guides' },
  'api-reference': {
    label: 'API Reference',
    order: 2,
    description: 'Complete endpoint documentation',
  },
  resources: { label: 'Resources', order: 3, description: 'Error codes, rate limits, changelog' },
});

// ---------------------------------------------------------------------------
// Navigation items -- every doc page is defined here
// ---------------------------------------------------------------------------

export const DOCS_NAV: readonly DocNavItem[] = Object.freeze([
  // Overview
  {
    slug: 'getting-started',
    title: 'Getting Started',
    description: 'Quick integration guide for the Crivacy KYC API',
    category: 'overview',
    order: 0,
  },

  // Guides
  {
    slug: 'authentication',
    title: 'Authentication',
    description: 'API key management, scopes, and security best practices',
    category: 'guides',
    order: 0,
  },
  {
    slug: 'oauth',
    title: 'OAuth / OIDC integration',
    description: 'Verify users via the Crivacy consent flow, the recommended integration path',
    category: 'guides',
    order: 1,
  },
  {
    slug: 'sessions',
    title: 'Sessions',
    description: 'Create, monitor, and cancel KYC verification sessions, the unit of work behind every credential',
    category: 'guides',
    order: 2,
  },
  {
    slug: 'credentials',
    title: 'Credentials',
    description: 'Working with re-usable KYC credentials on Sepolia',
    category: 'guides',
    order: 3,
  },
  {
    slug: 'webhooks',
    title: 'Webhooks',
    description: 'Real-time event delivery and signature verification',
    category: 'guides',
    order: 4,
  },

  // API Reference
  {
    slug: 'api-reference',
    title: 'API Reference',
    description: 'Complete REST API documentation auto-generated from OpenAPI',
    category: 'api-reference',
    order: 0,
    isApiReference: true,
  },

  // Resources
  {
    slug: 'error-codes',
    title: 'Error Codes',
    description: 'Comprehensive error code reference and troubleshooting',
    category: 'resources',
    order: 0,
  },
  {
    slug: 'rate-limits',
    title: 'Rate Limits',
    description: 'Rate limit tiers, quotas, and best practices',
    category: 'resources',
    order: 1,
  },
  {
    slug: 'changelog',
    title: 'Changelog',
    description: 'API version history and breaking changes',
    category: 'resources',
    order: 2,
  },
]) as readonly DocNavItem[];

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Look up a single nav item by slug. */
export function getDocNavItem(slug: string): DocNavItem | undefined {
  return DOCS_NAV.find((item) => item.slug === slug);
}

/** Return all nav items for a given category, sorted by `order`. */
export function getDocsByCategory(category: DocCategory): readonly DocNavItem[] {
  return DOCS_NAV.filter((item) => item.category === category).sort((a, b) => a.order - b.order);
}

/** Return every registered doc slug. */
export function getAllDocSlugs(): readonly string[] {
  return DOCS_NAV.map((item) => item.slug);
}

/**
 * Build the full sidebar tree grouped by category.
 * Categories with zero items are omitted.
 */
export function getSidebarTree(): ReadonlyArray<{
  category: DocCategoryMeta & { key: DocCategory };
  items: readonly DocNavItem[];
}> {
  const categories = Object.entries(DOC_CATEGORIES) as Array<[DocCategory, DocCategoryMeta]>;
  return categories
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([key, meta]) => ({
      category: { ...meta, key },
      items: getDocsByCategory(key),
    }))
    .filter((group) => group.items.length > 0);
}
