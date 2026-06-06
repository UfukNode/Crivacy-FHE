/**
 * Dev-only mock Didit server — bypass the QR / phone capture entirely.
 *
 * Serves the two Didit endpoints the app + workers consume:
 *   * POST /v3/session/                  → fake session (createSession)
 *   * GET  /v3/session/:id/decision/     → fake **Approved** decision
 *
 * With the app + worker processes pointed at this server via
 * `DIDIT_BASE_URL=http://localhost:3099`, the normal flow drives itself:
 * the user clicks "Start KYC", the app's SSE pull-fallback polls
 * `getDecision` (this mock → Approved), transitions the session to
 * `identity_approved`, enqueues the credential pipeline, and the worker
 * mints on Sepolia — no phone, no QR, no webhook. Exercises the REAL
 * pipeline + UI transitions (verifying → minting → verified).
 *
 * Usage (three terminals — app + workers must use the mock base URL):
 *   Terminal 1:  DIDIT_BASE_URL=http://localhost:3099 pnpm --filter @crivacy/web dev
 *   Terminal 2:  DIDIT_BASE_URL=http://localhost:3099 pnpm --filter @crivacy/web dev:workers
 *   Terminal 3:  pnpm --filter @crivacy/web exec tsx scripts/dev-fake-didit.ts
 *
 * SECURITY: dev-only. Never point a real deployment at this — it
 * approves every session unconditionally.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  CreateSessionResponseSchema,
  DecisionResponseSchema,
} from '@crivacy-fhe/adapter-didit/schemas';

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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
loadEnv(resolve(here, '../.env'));
loadEnv(resolve(here, '../.env.local'));

const PORT = Number.parseInt(process.env['FAKE_DIDIT_PORT'] ?? '3099', 10);
const KYC_WORKFLOW_ID = process.env['DIDIT_KYC_WORKFLOW_ID'] ?? '';
const ADDRESS_WORKFLOW_ID = process.env['DIDIT_ADDRESS_WORKFLOW_ID'] ?? '';

if (KYC_WORKFLOW_ID.length === 0) {
  console.error('[fake-didit] DIDIT_KYC_WORKFLOW_ID missing from env');
  process.exit(1);
}

// session_id → { workflow_id, vendor_data } recorded at createSession so
// getDecision echoes a consistent workflow + vendor_data (hydrate
// re-validates both). Falls back to the KYC workflow for sessions this
// process never saw (e.g. created before a mock restart).
const sessions = new Map<string, { workflowId: string; vendorData: string }>();

// Best-effort DB lookup so app-created sessions (real Didit createSession,
// not in our in-memory map) still get a decision matching their workflow
// (identity vs address). Null if the DB is unreachable.
let dbLookup: ((diditSessionId: string) => Promise<'identity' | 'address' | null>) | null = null;
try {
  const { getDatabaseClient } = await import('@/lib/db/client');
  const { sql } = await import('drizzle-orm');
  const { db } = getDatabaseClient();
  dbLookup = async (diditSessionId: string) => {
    const rows = await db.execute<{ workflow: string }>(
      sql`SELECT workflow::text AS workflow FROM kyc_sessions WHERE didit_session_id = ${diditSessionId} LIMIT 1`,
    );
    const wf = rows.rows[0]?.workflow;
    return wf === 'address' ? 'address' : wf === 'identity' ? 'identity' : null;
  };
} catch {
  dbLookup = null;
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

/** Build an Approved KYC decision that reduceDecision maps to
 *  identityVerified + livenessVerified = true. */
function buildApprovedDecision(
  sessionId: string,
  workflowId: string,
  vendorData: string,
): unknown {
  const isAddress = workflowId === ADDRESS_WORKFLOW_ID;
  const base: Record<string, unknown> = {
    session_id: sessionId,
    workflow_id: workflowId,
    vendor_data: vendorData,
    status: 'Approved',
    human_score: 92,
    created_at: new Date(0).toISOString(),
  };
  if (isAddress) {
    base['poa_verifications'] = [
      {
        status: 'Approved',
        document_type: 'utility_bill',
        poa_parsed_address: { country: 'TR' },
      },
    ];
    return base;
  }
  base['id_verifications'] = [
    {
      status: 'Approved',
      document_type: 'passport',
      document_number: 'X1234567',
      first_name: 'Alex',
      last_name: 'Morgan',
      full_name: 'Alex Morgan',
      issuing_country: 'TR',
      date_of_birth: '1990-01-01',
      expiration_date: '2032-01-01',
    },
  ];
  base['liveness_checks'] = [{ status: 'Approved', score: 96 }];
  base['face_matches'] = [{ status: 'Approved', score: 95 }];
  return base;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const send = (code: number, obj: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // POST /v3/session/ — createSession
  if (req.method === 'POST' && url.pathname === '/v3/session/') {
    void readBody(req).then((raw) => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* tolerate */
      }
      const sessionId = randomUUID();
      const workflowId =
        typeof body['workflow_id'] === 'string' ? (body['workflow_id'] as string) : KYC_WORKFLOW_ID;
      const vendorData =
        typeof body['vendor_data'] === 'string' ? (body['vendor_data'] as string) : 'fake-vendor';
      sessions.set(sessionId, { workflowId, vendorData });

      const response = {
        session_id: sessionId,
        session_token: `fake-token-${sessionId}-padding`,
        session_url: `http://localhost:${PORT}/fake-hosted/${sessionId}`,
        url: `http://localhost:${PORT}/fake-hosted/${sessionId}`,
        workflow_id: workflowId,
        vendor_data: vendorData,
        session_number: 1,
        status: 'Not Started',
      };
      const parsed = CreateSessionResponseSchema.safeParse(response);
      if (!parsed.success) {
        console.error('[fake-didit] createSession response failed schema:', parsed.error.issues);
        send(500, { error: 'mock_schema_mismatch' });
        return;
      }
      console.log(`[fake-didit] createSession → ${sessionId} (workflow ${workflowId.slice(0, 8)})`);
      send(200, response);
    });
    return;
  }

  // GET /v3/session/:id/decision/ — always Approved
  const decMatch = /^\/v3\/session\/([^/]+)\/decision\/?$/.exec(url.pathname);
  if (req.method === 'GET' && decMatch !== null) {
    const sessionId = decodeURIComponent(decMatch[1]!);
    void (async () => {
      const known = sessions.get(sessionId);
      let workflowId = known?.workflowId ?? KYC_WORKFLOW_ID;
      const vendorData = known?.vendorData ?? 'fake-vendor';
      // App-created sessions (real Didit createSession) are not in our
      // in-memory map, so resolve the workflow from the DB row by
      // didit_session_id — otherwise an address session would wrongly
      // get a KYC decision and the enhanced mint would mis-reduce.
      if (known === undefined && dbLookup !== null) {
        try {
          const wf = await dbLookup(sessionId);
          if (wf === 'address' && ADDRESS_WORKFLOW_ID.length > 0) workflowId = ADDRESS_WORKFLOW_ID;
          else if (wf === 'identity') workflowId = KYC_WORKFLOW_ID;
        } catch {
          /* fall back to KYC */
        }
      }
      const decision = buildApprovedDecision(sessionId, workflowId, vendorData);
      const parsed = DecisionResponseSchema.safeParse(decision);
      if (!parsed.success) {
        console.error('[fake-didit] decision failed schema:', JSON.stringify(parsed.error.issues, null, 2));
        send(500, { error: 'mock_schema_mismatch' });
        return;
      }
      const wfTag = workflowId === ADDRESS_WORKFLOW_ID ? 'address' : 'identity';
      console.log(`[fake-didit] getDecision ${sessionId.slice(0, 8)} → Approved (${wfTag})`);
      send(200, decision);
    })();
    return;
  }

  // GET /v3/users/:vendorData/ — user entity (name anchor for address PoA)
  const userMatch = /^\/v3\/users\/([^/]+)\/?$/.exec(url.pathname);
  if (req.method === 'GET' && userMatch !== null) {
    const vendorData = decodeURIComponent(userMatch[1]!);
    console.log(`[fake-didit] getUser ${vendorData.slice(0, 12)} → Alex Morgan`);
    send(200, {
      vendor_data: vendorData,
      full_name: 'Alex Morgan',
      first_name: 'Alex',
      last_name: 'Morgan',
      date_of_birth: '1990-01-01',
    });
    return;
  }

  send(404, { error: 'not_found', path: url.pathname });
});

server.listen(PORT, () => {
  console.log(`[fake-didit] mock Didit listening on http://localhost:${PORT}`);
  console.log('[fake-didit] point app + workers at it: DIDIT_BASE_URL=http://localhost:' + PORT);
  console.log('[fake-didit] every session auto-approves. dev-only.');
});
