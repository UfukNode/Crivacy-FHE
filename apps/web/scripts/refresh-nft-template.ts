/**
 * Dev helper: refresh the inline `ENHANCED_SVG_TEMPLATE` literal in
 * `src/lib/nft/build-nft.ts` from the canonical source-of-truth at
 * `public/static/nft/enhanced.svg`. Run after the design changes:
 *
 *   pnpm --filter @crivacy/web exec tsx scripts/refresh-nft-template.ts
 *
 * The file's bookended by two sentinel comments so we can find the
 * literal without depending on whitespace; the helper rewrites only
 * the bytes between them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(here, '..', 'public', 'static', 'nft', 'enhanced.svg');
const tsPath = resolve(here, '..', 'src', 'lib', 'nft', 'build-nft.ts');

const raw = readFileSync(svgPath, 'utf8');
const escaped = raw
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

const ts = readFileSync(tsPath, 'utf8');
const startMarker = '/* @nft-svg-start */';
const endMarker = '/* @nft-svg-end */';
const startIdx = ts.indexOf(startMarker);
const endIdx = ts.indexOf(endMarker);
if (startIdx === -1 || endIdx === -1) {
  console.error(
    `[refresh-nft-template] Marker comments not found in ${tsPath}. Add\n  ${startMarker}\n  \`...\`\n  ${endMarker}\nbookending the template literal.`,
  );
  process.exit(1);
}

const head = ts.slice(0, startIdx + startMarker.length);
const tail = ts.slice(endIdx);
const body = `\nconst ENHANCED_SVG_TEMPLATE = \`${escaped}\`;\n`;
const next = `${head}${body}${tail}`;
writeFileSync(tsPath, next, 'utf8');
console.log(`[refresh-nft-template] ${tsPath} updated (${escaped.length} chars).`);
