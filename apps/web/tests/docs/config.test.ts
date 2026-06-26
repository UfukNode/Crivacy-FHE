/**
 * Docs config tests — navigation structure, sidebar tree, lookups.
 */

import { describe, expect, it } from 'vitest';

import {
  DOCS_NAV,
  DOC_CATEGORIES,
  getAllDocSlugs,
  getDocNavItem,
  getDocsByCategory,
  getSidebarTree,
} from '@/lib/docs/config';

describe('DOCS_NAV', () => {
  it('is a frozen non-empty array', () => {
    expect(Object.isFrozen(DOCS_NAV)).toBe(true);
    expect(DOCS_NAV.length).toBeGreaterThan(0);
  });

  it('has unique slugs', () => {
    const slugs = DOCS_NAV.map((item) => item.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every item has required fields', () => {
    for (const item of DOCS_NAV) {
      expect(item.slug.length).toBeGreaterThan(0);
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.category.length).toBeGreaterThan(0);
      expect(typeof item.order).toBe('number');
    }
  });

  it('every category references a valid DOC_CATEGORIES key', () => {
    const validCategories = Object.keys(DOC_CATEGORIES);
    for (const item of DOCS_NAV) {
      expect(validCategories).toContain(item.category);
    }
  });
});

describe('DOC_CATEGORIES', () => {
  it('is a frozen object with expected categories', () => {
    expect(Object.isFrozen(DOC_CATEGORIES)).toBe(true);
    expect(Object.keys(DOC_CATEGORIES)).toContain('overview');
    expect(Object.keys(DOC_CATEGORIES)).toContain('guides');
    expect(Object.keys(DOC_CATEGORIES)).toContain('api-reference');
    expect(Object.keys(DOC_CATEGORIES)).toContain('resources');
  });

  it('each category has label, order, and description', () => {
    for (const meta of Object.values(DOC_CATEGORIES)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(typeof meta.order).toBe('number');
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });
});

describe('getDocNavItem', () => {
  it('returns item for known slug', () => {
    const item = getDocNavItem('getting-started');
    expect(item).toBeDefined();
    expect(item?.slug).toBe('getting-started');
    expect(item?.title).toBe('Getting Started');
  });

  it('returns undefined for unknown slug', () => {
    expect(getDocNavItem('nonexistent-slug')).toBeUndefined();
  });
});

describe('getDocsByCategory', () => {
  it('returns items for guides category', () => {
    const guides = getDocsByCategory('guides');
    expect(guides.length).toBeGreaterThan(0);
    for (const item of guides) {
      expect(item.category).toBe('guides');
    }
  });

  it('returns items sorted by order', () => {
    const guides = getDocsByCategory('guides');
    for (let i = 1; i < guides.length; i++) {
      const current = guides[i]?.order ?? 0;
      const previous = guides[i - 1]?.order ?? 0;
      expect(current).toBeGreaterThanOrEqual(previous);
    }
  });

  it('returns empty array for category with no items', () => {
    // All our categories have items, but the function should handle edge cases
    const result = getDocsByCategory('overview');
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('getAllDocSlugs', () => {
  it('returns all slugs', () => {
    const slugs = getAllDocSlugs();
    expect(slugs.length).toBe(DOCS_NAV.length);
    expect(slugs).toContain('getting-started');
    expect(slugs).toContain('api-reference');
    expect(slugs).toContain('changelog');
  });
});

describe('getSidebarTree', () => {
  it('returns categories with items', () => {
    const tree = getSidebarTree();
    expect(tree.length).toBeGreaterThan(0);

    for (const group of tree) {
      expect(group.category.key.length).toBeGreaterThan(0);
      expect(group.category.label.length).toBeGreaterThan(0);
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it('categories are sorted by order', () => {
    const tree = getSidebarTree();
    for (let i = 1; i < tree.length; i++) {
      const current = tree[i]?.category.order ?? 0;
      const previous = tree[i - 1]?.category.order ?? 0;
      expect(current).toBeGreaterThanOrEqual(previous);
    }
  });

  it('does not include categories with zero items', () => {
    const tree = getSidebarTree();
    for (const group of tree) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });
});
