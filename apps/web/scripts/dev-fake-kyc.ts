/**
 * Dev-only headless KYC bypass driver — no phone, no QR, no browser.
 *
 * Requires the mock Didit server running (`scripts/dev-fake-didit.ts`)
 * AND the worker process pointed at it
 * (`DIDIT_BASE_URL=http://localhost:3099 pnpm dev:workers`).
 *
 * Flow:
 *   1. Pick a customer with a linked EVM wallet (or --email=<addr>).
 *   2. Insert an in-progress identity kyc_session.
 *   3. Fire a signed "Approved" Didit webhook at the local app so the
 *      session flips to identity_approved + the credential pipeline is
 *      enqueued (same path the real webhook uses).
 *   4. The worker fetches the decision from the MOCK (→ Approved) and
 *      mints on Sepolia. We poll until the credential row lands.
 *
 * Usage:
 *   pnpm --filter @crivacy/web exec tsx scripts/dev-fake-kyc.ts [--email=<customer>]
 *
 * SECURITY: dev-only. Approves KYC unconditionally.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, desc, eq } from 'drizzle-orm';

import { canonicalJson } from '@crivacy-fhe/adapter-didit/canonical';

function loadEnv(path: string): void {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq2 = line.indexOf('=');
    if (eq2 === -1) continue;
    const key = line.slice(0, eq2).trim();
    let value = line.slice(eq2 + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
loadEnv(resolve(here, '../.env'));
loadEnv(resolve(here, '../.env.local'));

function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main(): Promise<void> {
  const { getDatabaseClient } = await import('@/lib/db/client');
  const schema = await import('@/lib/db/schema');
  const { getCustomerWalletAddress } = await import('@/lib/fhe/customer-address');

  const { db } = getDatabaseClient();

  const email = arg('email');
  const baseUrl = arg('base-url') ?? 'http://localhost:3001';
  const secret = process.env['DIDIT_WEBHOOK_SECRET'];
  const kycWorkflowId = process.env['DIDIT_KYC_WORKFLOW_ID'];
  const firmId = process.env['CRIVACY_SELF_SERVICE_FIRM_ID'];
  if (!secret || !kycWorkflowId || !firmId) {
    throw new Error('DIDIT_WEBHOOK_SECRET, DIDIT_KYC_WORKFLOW_ID, CRIVACY_SELF_SERVICE_FIRM_ID required');
  }

  // 1. Resolve the customer + wallet.
  const customerRows = email
    ? await db.select().from(schema.customers).where(eq(schema.customers.email, email)).limit(1)
    : await db.select().from(schema.customers).orderBy(desc(schema.customers.createdAt)).limit(20);

  let customer: (typeof customerRows)[number] | undefined;
  let wallet: string | null = null;
  for (const c of customerRows) {
    const w = await getCustomerWalletAddress(db, c.id);
    if (w !== null) {
      customer = c;
      wallet = w;
      break;
    }
  }
  if (customer === undefined || wallet === null) {
    throw new Error(
      email
        ? `Customer ${email} has no linked EVM wallet. Link one first.`
        : 'No customer with a linked EVM wallet found. Pass --email or link a wallet.',
    );
  }
  console.log(`[fake-kyc] customer=${customer.email} (${customer.id.slice(0, 8)}) wallet=${wallet}`);

  // 1b. Clear this customer's prior KYC so the test is repeatable and the
  //     `kyc_sessions_customer_workflow_active_key` unique constraint does
  //     not trip. Order respects FKs: handoffs + credential-meta reference
  //     the session, so drop them first. Dev-only, single customer.
  const { sql } = await import('drizzle-orm');
  await db.delete(schema.kycDeviceHandoffs).where(eq(schema.kycDeviceHandoffs.customerId, customer.id));
  // Credential-meta references the session (kyc_session_id FK) — drop the
  // meta for every session this customer owns before deleting the sessions.
  await db.execute(
    sql`DELETE FROM kyc_credentials_meta WHERE kyc_session_id IN (SELECT id FROM kyc_sessions WHERE customer_id = ${customer.id})`,
  );
  await db.delete(schema.kycSessions).where(eq(schema.kycSessions.customerId, customer.id));
  await db
    .update(schema.customers)
    .set({ kycLevel: 'kyc_0', kycScore: 0, updatedAt: new Date() })
    .where(eq(schema.customers.id, customer.id));
  console.log('[fake-kyc] cleared prior KYC state for a fresh run');

  // 2. Insert an in-progress identity session.
  const sessionId = randomUUID();
  const diditSessionId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
  // kyc_sessions_kind_invariant: customer sessions MUST have
  // firm_id / user_ref / created_by_api_key_id all NULL (only b2b
  // sessions carry those). The self-service firm is attributed on the
  // credential-meta row at mint time, not on the session.
  await db.insert(schema.kycSessions).values({
    id: sessionId,
    kind: 'customer',
    customerId: customer.id,
    workflow: 'identity',
    level: 'basic',
    status: 'in_progress',
    diditSessionId,
    diditWorkflowId: kycWorkflowId,
    expiresAt,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  console.log(`[fake-kyc] session inserted ${sessionId.slice(0, 8)} (didit ${diditSessionId.slice(0, 8)})`);

  // 3. Fire a signed Approved webhook (session-level status.updated).
  const nowMs = now.getTime();
  const vendorData = JSON.stringify({ type: 'customer', crivacySessionId: sessionId, customerId: customer.id });
  const body = {
    session_id: diditSessionId,
    workflow_id: kycWorkflowId,
    vendor_data: vendorData,
    status: 'Approved',
    timestamp: new Date(nowMs).toISOString(),
    webhook_type: 'status.updated',
  };
  const canonical = canonicalJson(body);
  const signature = createHmac('sha256', secret).update(canonical).digest('hex');
  const res = await fetch(`${baseUrl}/api/webhooks/didit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-timestamp': String(Math.floor(nowMs / 1000)),
      'x-signature-v2': signature,
    },
    body: canonical,
  });
  console.log(`[fake-kyc] webhook → HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  if (!res.ok) throw new Error('webhook rejected — is the app running on ' + baseUrl + '?');

  // 4. Poll for the minted credential.
  console.log('[fake-kyc] waiting for the worker to mint (needs dev:workers on the mock)…');
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const cred = await db
      .select({ status: schema.kycCredentialsMeta.status, sub: schema.kycCredentialsMeta.chainSubmissionId })
      .from(schema.kycCredentialsMeta)
      .where(
        and(
          eq(schema.kycCredentialsMeta.kycSessionId, sessionId),
          eq(schema.kycCredentialsMeta.status, 'active'),
        ),
      )
      .limit(1);
    if (cred[0] !== undefined) {
      console.log(`[fake-kyc] ✅ MINTED — tx ${cred[0].sub} (status ${cred[0].status})`);
      const fresh = await db
        .select({ level: schema.customers.kycLevel })
        .from(schema.customers)
        .where(eq(schema.customers.id, customer.id))
        .limit(1);
      console.log(`[fake-kyc] customer kyc_level → ${fresh[0]?.level}`);
      process.exit(0);
    }
  }
  console.error('[fake-kyc] timed out waiting for mint — check dev:workers (DIDIT_BASE_URL=mock?) + fake-didit server');
  process.exit(1);
}

void main().catch((err) => {
  console.error('[fake-kyc] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
