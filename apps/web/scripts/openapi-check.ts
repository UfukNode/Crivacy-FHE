#!/usr/bin/env tsx
/**
 * Fail-fast drift check for the committed OpenAPI spec.
 *
 * Regenerates the YAML and JSON outputs in-memory and compares them to
 * the on-disk copies under `docs/api/`. If either differs, the script
 * prints a unified-diff-style hint and exits non-zero so CI catches
 * forgotten `openapi:build` runs.
 *
 * Run from the repo root: `pnpm --filter @crivacy/web openapi:check`.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOpenApiDocument,
  serializeOpenApiToJson,
  serializeOpenApiToYaml,
} from '../src/lib/openapi';

const thisFile = fileURLToPath(import.meta.url);
const webRoot = resolve(dirname(thisFile), '..');
const repoRoot = resolve(webRoot, '..', '..');
const docsApiDir = join(repoRoot, 'docs', 'api');
const yamlPath = join(docsApiDir, 'openapi.yaml');
const jsonPath = join(docsApiDir, 'openapi.json');

async function readOr(label: string, path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `openapi-check: missing ${label} at ${path}. Run \`pnpm --filter @crivacy/web openapi:build\`.`,
    );
  }
}

function firstDifference(
  a: string,
  b: string,
): { line: number; aSample: string; bSample: string } | null {
  if (a === b) return null;
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i += 1) {
    const aLine = aLines[i] ?? '';
    const bLine = bLines[i] ?? '';
    if (aLine !== bLine) {
      return { line: i + 1, aSample: aLine, bSample: bLine };
    }
  }
  return { line: max, aSample: '', bSample: '' };
}

async function main(): Promise<void> {
  const document = buildOpenApiDocument();
  const expectedYaml = serializeOpenApiToYaml(document);
  const expectedJson = serializeOpenApiToJson(document);

  const [committedYaml, committedJson] = await Promise.all([
    readOr('docs/api/openapi.yaml', yamlPath),
    readOr('docs/api/openapi.json', jsonPath),
  ]);

  const failures: string[] = [];

  const yamlDiff = firstDifference(committedYaml, expectedYaml);
  if (yamlDiff) {
    failures.push(
      `openapi-check: docs/api/openapi.yaml drifted from the registry.\n` +
        `  First mismatch at line ${yamlDiff.line}\n` +
        `  committed: ${yamlDiff.aSample}\n` +
        `  generated: ${yamlDiff.bSample}`,
    );
  }

  const jsonDiff = firstDifference(committedJson, expectedJson);
  if (jsonDiff) {
    failures.push(
      `openapi-check: docs/api/openapi.json drifted from the registry.\n` +
        `  First mismatch at line ${jsonDiff.line}\n` +
        `  committed: ${jsonDiff.aSample}\n` +
        `  generated: ${jsonDiff.bSample}`,
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    console.error('\nRun `pnpm --filter @crivacy/web openapi:build` and commit the result.');
    process.exit(1);
  }

  const pathCount = Object.keys(document.paths ?? {}).length;
  const schemaCount = Object.keys(document.components?.schemas ?? {}).length;
  console.log(`openapi-check: in sync (${pathCount} paths, ${schemaCount} schemas).`);
}

main().catch((err: unknown) => {
  console.error('openapi-check: failed');
  console.error(err);
  process.exit(1);
});
