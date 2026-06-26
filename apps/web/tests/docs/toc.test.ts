/**
 * Table of contents extraction tests.
 */

import { describe, expect, it } from 'vitest';

import { extractToc, slugify } from '@/lib/docs/toc';

describe('slugify', () => {
  it('converts text to lowercase slug', () => {
    expect(slugify('Getting Started')).toBe('getting-started');
  });

  it('removes special characters', () => {
    expect(slugify('Error Codes & Troubleshooting')).toBe('error-codes-troubleshooting');
  });

  it('collapses multiple dashes', () => {
    expect(slugify('A -- B')).toBe('a-b');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('--hello--')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('handles numbers', () => {
    expect(slugify('Step 1: Create a Session')).toBe('step-1-create-a-session');
  });
});

describe('extractToc', () => {
  it('extracts h2 headings', () => {
    const content = '## Introduction\n\nSome text.\n\n## Getting Started\n\nMore text.';
    const toc = extractToc(content);

    expect(toc).toHaveLength(2);
    expect(toc[0]?.title).toBe('Introduction');
    expect(toc[0]?.level).toBe(2);
    expect(toc[0]?.id).toBe('introduction');
    expect(toc[1]?.title).toBe('Getting Started');
  });

  it('skips h1 headings', () => {
    const content = '# Title\n\n## Section\n\nText.';
    const toc = extractToc(content);

    expect(toc).toHaveLength(1);
    expect(toc[0]?.title).toBe('Section');
  });

  it('handles h3 and h4 headings', () => {
    const content = '## Parent\n\n### Child\n\n#### Grandchild';
    const toc = extractToc(content);

    expect(toc).toHaveLength(1);
    expect(toc[0]?.title).toBe('Parent');
    expect(toc[0]?.children).toHaveLength(1);
    expect(toc[0]?.children[0]?.title).toBe('Child');
    expect(toc[0]?.children[0]?.children).toHaveLength(1);
    expect(toc[0]?.children[0]?.children[0]?.title).toBe('Grandchild');
  });

  it('builds correct nesting structure', () => {
    const content = [
      '## Section A',
      '### Subsection A1',
      '### Subsection A2',
      '## Section B',
      '### Subsection B1',
    ].join('\n\n');

    const toc = extractToc(content);

    expect(toc).toHaveLength(2);
    expect(toc[0]?.title).toBe('Section A');
    expect(toc[0]?.children).toHaveLength(2);
    expect(toc[1]?.title).toBe('Section B');
    expect(toc[1]?.children).toHaveLength(1);
  });

  it('returns empty array for content with no headings', () => {
    const content = 'Just some text without any headings.';
    expect(extractToc(content)).toHaveLength(0);
  });

  it('handles headings deeper than h4 by ignoring them', () => {
    const content = '## Valid\n\n##### Too Deep';
    const toc = extractToc(content);

    expect(toc).toHaveLength(1);
    expect(toc[0]?.title).toBe('Valid');
  });

  it('handles h3 at root level (no parent h2)', () => {
    const content = '### Orphan H3\n\n### Another H3';
    const toc = extractToc(content);

    expect(toc).toHaveLength(2);
    expect(toc[0]?.title).toBe('Orphan H3');
    expect(toc[1]?.title).toBe('Another H3');
  });
});
