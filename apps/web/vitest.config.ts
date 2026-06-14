/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Minimal `.env` loader so vitest sees the same vars Next.js does.
 * Reads `.env` then `.env.local` (latter overrides). No `$` expansion,
 * comments stripped, surrounding quotes peeled. We avoid `vite`/`dotenv`
 * direct deps because pnpm doesn't hoist them into apps/web.
 */
function loadDotEnv(cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['.env', '.env.local']) {
    const filePath = path.join(cwd, file);
    if (!fs.existsSync(filePath)) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  }
  return out;
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(dirname, 'src'),
      '@/components': path.resolve(dirname, 'src/components'),
      '@/lib': path.resolve(dirname, 'src/lib'),
      '@/server': path.resolve(dirname, 'src/server'),
      '@/styles': path.resolve(dirname, 'src/styles'),
      '@/app': path.resolve(dirname, 'src/app'),
    },
  },
  test: {
    // `.env.local` carries `NODE_ENV=production` for the dev-mode worker
    // override, but vitest must run React in dev/test mode (the
    // production build of React strips `act()` which @testing-library
    // relies on). Force the override here so component specs can use
    // RTL regardless of the local env file.
    env: { ...loadDotEnv(dirname), NODE_ENV: 'test' },
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next', '.turbo', 'dist', 'coverage'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.stories.{ts,tsx}',
        'src/app/**/layout.tsx',
        'src/app/**/not-found.tsx',
        'src/app/**/error.tsx',
        'src/styles/**',
      ],
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
});
