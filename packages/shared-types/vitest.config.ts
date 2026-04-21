/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

/**
 * `@crivacy/shared-types` is a runtime-free type package. Vitest is wired
 * here only to host type-level assertions via `expectTypeOf`. The actual
 * type validation is performed by `pnpm typecheck` (tsc --noEmit) which
 * picks up `tests/**\/*.ts` via tsconfig.json's include glob; vitest itself
 * just runs the file at runtime as a smoke check (`expectTypeOf` is a
 * runtime no-op, so any test passes as long as the file compiles).
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', '.turbo', 'dist'],
  },
});
