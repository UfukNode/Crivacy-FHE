/**
 * Provision the demo relying firm for the standalone Test-FHE-Dapp
 * (`apps/test-firm`).
 *
 * The Test-FHE-Dapp consumes Crivacy's OAuth + REST exactly like a real
 * third-party firm. That requires three real rows in Crivacy's DB: a
 * `firms` row, an `oauth_clients` row (with a redirect_uri pointing at
 * the harness origin), and an `api_keys` row. This script inserts them
 * using the app's OWN credential primitives — `generateClientId` /
 * `hashClientSecret` (argon2id) and `generateApiKey` / `hashApiKey`
 * (bcrypt) — so the stored hashes verify against the live auth paths.
 *
 * It is idempotent: it finds-or-creates the firm by slug, then wipes
 * and re-issues that firm's OAuth client + API key on every run. The
 * freshly generated plaintext credentials are written straight into
 * `apps/test-firm/.env` (TEST_FIRM_OAUTH_CLIENT_ID / _SECRET / _API_KEY),
 * so the harness picks them up on its next restart.
 *
 * Usage (from repo root):
 *   pnpm --filter @crivacy/web exec tsx scripts/provision-test-firm.ts
 *
 * The redirect_uri + own origin default to the harness dev origin
 * (http://localhost:3002); override with TEST_FIRM_ORIGIN if needed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..'); // apps/web
const repoRoot = path.resolve(webRoot, '../..'); // monorepo root
const testFirmEnvPath = path.resolve(repoRoot, 'apps/test-firm/.env');

// ---------------------------------------------------------------------------
// Minimal .env loader (zero-dep) — mirrors scripts/db-setup.ts. First file
// wins; an existing process.env value always wins.
// ---------------------------------------------------------------------------
function loadEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match === null) continue;
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

loadEnv(path.resolve(webRoot, '.env'));
loadEnv(path.resolve(repoRoot, '.env'));

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL_ADMIN'] ?? process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    console.error('[provision-test-firm] DATABASE_URL_ADMIN / DATABASE_URL not set.');
    process.exit(1);
  }

  // Import the app's own credential primitives + schema so the stored
  // hashes are byte-for-byte what the live verify paths expect.
  const { generateClientId, generateClientSecret, hashClientSecret } = await import(
    '../src/lib/oauth/client'
  );
  const { generateApiKey } = await import('../src/lib/auth/keygen');
  const { hashApiKey } = await import('../src/lib/auth/api-key');
  const schema = await import('../src/lib/db/schema');

  const ownOrigin = (process.env['TEST_FIRM_ORIGIN'] ?? 'http://localhost:3002').replace(/\/$/, '');
  const redirectUris = [`${ownOrigin}/callback`, 'http://127.0.0.1:3002/callback'];

  // OAuth scopes the harness requests at /authorize. `kyc` implies
  // `credential` (expandImplicitScopes in the dashboard handler), so it is
  // included explicitly to match exactly what the app would store.
  const allowedScopes = ['openid', 'kyc', 'kyc:address', 'kyc:scores', 'credential'];
  // Full API-key scope set so every REST call the harness makes succeeds.
  const apiKeyScopes = ['kyc:create', 'kyc:read', 'kyc:verify', 'webhooks:manage', 'usage:read'];

  const FIRM_SLUG = 'test-fhe-dapp';
  const FIRM_NAME = 'Northwind Finance';
  const FIRM_EMAIL = 'demo@testfirm.dev';

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  try {
    // 1. Find-or-create the firm by slug.
    const existingFirm = await db
      .select({ id: schema.firms.id })
      .from(schema.firms)
      .where(eq(schema.firms.slug, FIRM_SLUG))
      .limit(1);

    let firmId: string;
    if (existingFirm[0] !== undefined) {
      firmId = existingFirm[0].id;
      console.log(`[provision-test-firm] reusing firm ${FIRM_SLUG} (${firmId})`);
    } else {
      const inserted = await db
        .insert(schema.firms)
        .values({ name: FIRM_NAME, slug: FIRM_SLUG, contactEmail: FIRM_EMAIL, tier: 'pro' })
        .returning({ id: schema.firms.id });
      firmId = inserted[0]!.id;
      // The app always pairs a firm with its settings row (all defaulted).
      await db.insert(schema.firmSettings).values({ firmId }).onConflictDoNothing();
      console.log(`[provision-test-firm] created firm ${FIRM_SLUG} (${firmId})`);
    }

    // 2. Wipe this firm's existing OAuth clients + API keys, then re-issue.
    await db.delete(schema.oauthClients).where(eq(schema.oauthClients.firmId, firmId));
    await db.delete(schema.apiKeys).where(eq(schema.apiKeys.firmId, firmId));

    // 3. OAuth client (confidential).
    const clientId = generateClientId('live');
    const clientSecret = generateClientSecret();
    const clientSecretHash = await hashClientSecret(clientSecret);
    await db.insert(schema.oauthClients).values({
      firmId,
      clientId,
      clientSecretHash,
      name: 'Northwind Finance',
      description: 'Demo relying firm verifying identity through Crivacy.',
      redirectUris,
      allowedScopes,
      isPublicClient: false,
      consentTtlDays: 90,
    });

    // 4. API key (live).
    const generated = generateApiKey('live');
    const { hash, algorithm, parameters } = await hashApiKey(
      generated.full,
      { apiKeyBcryptCost: 12 },
    );
    await db.insert(schema.apiKeys).values({
      firmId,
      name: 'Northwind Finance key',
      prefix: generated.prefix,
      hash,
      hashAlgorithm: algorithm,
      hashParameters: parameters,
      mode: 'live',
      scopes: apiKeyScopes,
    });

    // 5. Write the plaintext credentials into apps/test-firm/.env.
    writeCredsToEnv({ clientId, clientSecret, apiKey: generated.full });

    console.log('\n[provision-test-firm] done. Credentials written to apps/test-firm/.env:');
    console.log(`  TEST_FIRM_OAUTH_CLIENT_ID=${clientId}`);
    console.log(`  TEST_FIRM_OAUTH_CLIENT_SECRET=${clientSecret}`);
    console.log(`  TEST_FIRM_API_KEY=${generated.full}`);
    console.log(`  redirect_uris: ${redirectUris.join(', ')}`);
    console.log('\nRestart the harness so it picks up the new credentials.');
  } finally {
    await pool.end();
  }
}

/**
 * Rewrite the three credential lines in `apps/test-firm/.env` in place,
 * preserving every other line. Fails loudly if the file is missing —
 * the harness .env must already exist (created during extraction).
 */
function writeCredsToEnv(creds: {
  clientId: string;
  clientSecret: string;
  apiKey: string;
}): void {
  if (!existsSync(testFirmEnvPath)) {
    console.error(`[provision-test-firm] ${testFirmEnvPath} not found — cannot write credentials.`);
    process.exit(1);
  }
  const replacements: Record<string, string> = {
    TEST_FIRM_OAUTH_CLIENT_ID: creds.clientId,
    TEST_FIRM_OAUTH_CLIENT_SECRET: creds.clientSecret,
    TEST_FIRM_API_KEY: creds.apiKey,
  };
  const seen = new Set<string>();
  const lines = readFileSync(testFirmEnvPath, 'utf8').split(/\r?\n/);
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m !== null && replacements[m[1] as string] !== undefined) {
      const key = m[1] as string;
      seen.add(key);
      return `${key}=${replacements[key]}`;
    }
    return line;
  });
  // Append any key that wasn't already present.
  for (const [key, value] of Object.entries(replacements)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  writeFileSync(testFirmEnvPath, next.join('\n'), 'utf8');
}

main().catch((err: unknown) => {
  console.error('[provision-test-firm] failed:', err);
  process.exit(1);
});
