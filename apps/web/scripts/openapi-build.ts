#!/usr/bin/env tsx
/**
 * Build `docs/api/openapi.yaml` (and a sibling `openapi.json`) from the
 * Zod registry. Invoked via `pnpm openapi:build` and wired into the
 * Turbo pipeline so anything that touches the schemas regenerates the
 * committed spec. Fails the CI check script if the regenerated spec
 * drifts from the committed copy — see `openapi-check.ts`.
 *
 * Run from the repo root: `pnpm --filter @crivacy/web openapi:build`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
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

async function main(): Promise<void> {
  const document = buildOpenApiDocument();
  const yaml = serializeOpenApiToYaml(document);
  const json = serializeOpenApiToJson(document);

  await mkdir(docsApiDir, { recursive: true });
  await writeFile(yamlPath, yaml, 'utf8');
  await writeFile(jsonPath, json, 'utf8');

  const pathCount = Object.keys(document.paths ?? {}).length;
  const schemaCount = Object.keys(document.components?.schemas ?? {}).length;

  console.log(
    `openapi-build: wrote ${yamlPath} and ${jsonPath} (${pathCount} paths, ${schemaCount} schemas).`,
  );
}

main().catch((err: unknown) => {
  console.error('openapi-build: failed');
  console.error(err);
  process.exit(1);
});
