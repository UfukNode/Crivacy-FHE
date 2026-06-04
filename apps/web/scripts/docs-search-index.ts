/**
 * Post-build script: generate Pagefind search index from Next.js build output.
 *
 * Run after `next build`:
 *   pnpm docs:search
 *
 * The index is written to `public/pagefind/` which Next.js serves statically.
 * The `DocsSearch` client component lazy-loads the Pagefind JS bundle from
 * that path.
 *
 * @module
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WEB_ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(WEB_ROOT, '.next');
const OUTPUT_DIR = path.join(WEB_ROOT, 'public', 'pagefind');

if (!fs.existsSync(BUILD_DIR)) {
  console.error('Error: .next/ build output not found. Run `pnpm build` first.');
  process.exit(1);
}

console.log('Building Pagefind search index...');

try {
  execSync(
    [
      'npx pagefind',
      `--site "${BUILD_DIR}"`,
      `--output-path "${OUTPUT_DIR}"`,
      '--glob "server/app/docs/**/*.html"',
    ].join(' '),
    {
      cwd: WEB_ROOT,
      stdio: 'inherit',
    },
  );

  console.log(`Search index written to ${OUTPUT_DIR}`);
} catch (err) {
  console.error('Pagefind indexing failed:', err);
  process.exit(1);
}
