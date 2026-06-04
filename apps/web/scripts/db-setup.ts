/**
 * One-command database setup for a fresh machine / CI.
 *
 * Loads env (apps/web/.env, then repo-root .env — first wins, existing
 * process.env always wins) without any dependency, then runs the full
 * bootstrap chain in order, stopping on the first failure:
 *
 *   1. apply-sql-migrations.ts  — all 39 SQL migrations (baseline + RLS
 *                                 roles + everything since), idempotent
 *   2. seed-rbac.ts             — 63 permissions + 7 preset roles
 *   3. seed-admin.ts            — dev admin users (password-only)
 *   4. seed-admin-roles.ts      — link admins to their preset role in
 *                                 user_roles (so permission checks pass)
 *
 * Every step is idempotent, so this is safe to re-run. It does NOT
 * start Postgres — bring that up first:
 *   docker compose -f infra/docker-compose/postgres/docker-compose.yml up -d
 *
 * Usage:
 *   pnpm db:setup
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..'); // apps/web
const repoRoot = path.resolve(webRoot, '../..'); // monorepo root

/**
 * Minimal `.env` loader — no dotenv dependency. Parses `KEY=VALUE`
 * lines, strips surrounding quotes, ignores comments/blanks, and never
 * overwrites a value already present in `process.env`.
 */
function loadEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1] as string;
    let value = match[2] as string;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(path.join(webRoot, '.env'));
loadEnv(path.join(repoRoot, '.env'));

if (!process.env['DATABASE_URL']) {
  console.error(
    '[db:setup] DATABASE_URL is not set and no .env was found in apps/web or the repo root.\n' +
      '           Copy apps/web/.env.example to apps/web/.env, then re-run.',
  );
  process.exit(1);
}

const steps: ReadonlyArray<readonly [script: string, label: string]> = [
  ['apply-sql-migrations.ts', 'Applying SQL migrations'],
  ['seed-rbac.ts', 'Seeding RBAC catalogue'],
  ['seed-admin.ts', 'Seeding dev admin users'],
  ['seed-admin-roles.ts', 'Linking admins to RBAC roles'],
];

for (const [script, label] of steps) {
  console.log(`\n[db:setup] ${label} (${script}) ...`);
  // shell:true so the `tsx` shim resolves from node_modules/.bin on
  // every OS (tsx.cmd on Windows). The script path has no spaces, but
  // quote it anyway for safety.
  const res = spawnSync(`tsx "${path.join(here, script)}"`, {
    stdio: 'inherit',
    env: process.env,
    shell: true,
  });
  if (res.status !== 0) {
    console.error(`\n[db:setup] Step failed: ${script} (exit ${String(res.status)})`);
    process.exit(res.status ?? 1);
  }
}

console.log('\n[db:setup] ✅ Done — schema applied, RBAC + admin users seeded.');
