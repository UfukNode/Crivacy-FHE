// @crivacy/eslint-config
//
// Crivacy uses Biome as the primary linter/organizer and Prettier as the
// formatter. ESLint is intentionally NOT installed in the monorepo; this
// package exports the shared Biome + Prettier preset paths so that future
// tools (or downstream packages) can reference them without duplicating the
// configuration.
//
// Consumers:
//   import { biomePresetPath, prettierPresetPath } from '@crivacy/eslint-config';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const biomePresetPath = resolve(__dirname, 'biome.preset.json');
export const prettierPresetPath = resolve(__dirname, 'prettier.preset.json');

export default {
  biomePresetPath,
  prettierPresetPath,
};
