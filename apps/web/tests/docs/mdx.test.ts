/**
 * MDX loader tests — frontmatter parsing and file loading.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAllDocs, loadDoc } from '@/lib/docs/mdx';

/* ---------- Test fixtures ---------- */

let tmpDir: string;

const SAMPLE_MDX = `---
title: Test Page
description: A test documentation page
lastUpdated: '2026-04-12'
---

## Introduction

This is a test page.

### Sub-section

More content here.
`;

const MINIMAL_MDX = `---
title: Minimal
description: Minimal page
---

Hello world.
`;

const NO_FRONTMATTER_MDX = `## No Frontmatter

Just content.
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crivacy-docs-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ---------- Tests ---------- */

describe('loadDoc', () => {
  it('loads a doc with full frontmatter', () => {
    fs.writeFileSync(path.join(tmpDir, 'test-page.mdx'), SAMPLE_MDX);

    const doc = loadDoc('test-page', tmpDir);

    expect(doc).not.toBeNull();
    expect(doc?.slug).toBe('test-page');
    expect(doc?.frontmatter.title).toBe('Test Page');
    expect(doc?.frontmatter.description).toBe('A test documentation page');
    expect(doc?.frontmatter.lastUpdated).toBe('2026-04-12');
    expect(doc?.content).toContain('## Introduction');
  });

  it('loads a doc with minimal frontmatter', () => {
    fs.writeFileSync(path.join(tmpDir, 'minimal.mdx'), MINIMAL_MDX);

    const doc = loadDoc('minimal', tmpDir);

    expect(doc?.frontmatter.title).toBe('Minimal');
    expect(doc?.frontmatter.lastUpdated).toBeUndefined();
  });

  it('handles missing frontmatter gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'no-fm.mdx'), NO_FRONTMATTER_MDX);

    const doc = loadDoc('no-fm', tmpDir);

    expect(doc).not.toBeNull();
    expect(doc?.frontmatter.title).toBe('no-fm'); // falls back to slug
    expect(doc?.frontmatter.description).toBe('');
    expect(doc?.content).toContain('## No Frontmatter');
  });

  it('returns null for non-existent slug', () => {
    const doc = loadDoc('does-not-exist', tmpDir);
    expect(doc).toBeNull();
  });

  it('strips frontmatter from content', () => {
    fs.writeFileSync(path.join(tmpDir, 'strip.mdx'), SAMPLE_MDX);

    const doc = loadDoc('strip', tmpDir);

    expect(doc?.content).not.toContain('---');
    expect(doc?.content).not.toContain('title:');
  });
});

describe('loadAllDocs', () => {
  it('loads all mdx files in directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'page-a.mdx'), SAMPLE_MDX);
    fs.writeFileSync(path.join(tmpDir, 'page-b.mdx'), MINIMAL_MDX);

    const docs = loadAllDocs(tmpDir);

    expect(docs).toHaveLength(2);
    const slugs = docs.map((d) => d.slug);
    expect(slugs).toContain('page-a');
    expect(slugs).toContain('page-b');
  });

  it('ignores non-mdx files', () => {
    fs.writeFileSync(path.join(tmpDir, 'page.mdx'), SAMPLE_MDX);
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# Not MDX');
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}');

    const docs = loadAllDocs(tmpDir);

    expect(docs).toHaveLength(1);
    expect(docs[0]?.slug).toBe('page');
  });

  it('returns empty array for non-existent directory', () => {
    const docs = loadAllDocs(path.join(tmpDir, 'nonexistent'));
    expect(docs).toHaveLength(0);
  });

  it('returns empty array for empty directory', () => {
    const docs = loadAllDocs(tmpDir);
    expect(docs).toHaveLength(0);
  });
});
