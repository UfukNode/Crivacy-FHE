/**
 * KYC session handlers — business logic for `/api/v1/sessions`.
 *
 * Each handler receives an `AuthenticatedContext` and returns a
 * `NextResponse`. The handler orchestrates: parse → validate → repo →
 * Didit client → audit → response.
 *
 * @module
 */

import type { NextResponse } from 'next/server';

import { getDiditConfig } from '@crivacy-fhe/adapter-didit/config';
import { createKycSession, validateVendorData } from '@crivacy-fhe/adapter-didit/session';
import { getAppUrl } from '@/lib/env/app-url';
import { getRootLogger } from '@/lib/observability/logger';
import { PaginationQuery } from '@/lib/openapi/common/pagination';
import { SessionCreateRequest } from '@/lib/openapi/schemas/session';
import { z } from 'zod';
import type { AuthenticatedContext } from '../context';
import { parseBody, parsePathParams, parseQuery } from '../middleware/parse';
import {
  cancelSession as cancelSessionRepo,
  createSession as createSessionRepo,
  findActiveSessionByUserRef,
  findSessionById,
  listSessions,
} from '../repositories';
import type { SessionListFilters } from '../repositories/sessions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_EXPIRY_HOURS = 24;

const PathIdParams = z.object({
  id: z.uuid(),
});

function sessionToSummary(session: {
  id: string;
  firmId: string;
  userRef: string;
  status: string;
  level: string;
  createdAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: session.id,
    firmId: session.firmId,
    userRef: session.userRef,
    status: session.status,
    level: session.level,
    createdAt: session.createdAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null,
  };
}

function sessionToDetail(
  session: {
    id: string;
    firmId: string;
    userRef: string;
    status: string;
    level: string;
    createdAt: Date;
    completedAt: Date | null;
    callbackUrl: string | null;
    returnUrl: string | null;
    metadata: unknown;
    expiresAt: Date;
    diditSessionId: string | null;
    diditWorkflowId: string;
    workflow: string;
    startedAt: Date;
  },
  hostedUrl: string | null = null,
) {
  const phases = [];

  // The hosted-flow URL must come from Didit's `POST /v3/session/`
  // response (the `url` field). Reconstructing it from
  // `diditSessionId` is wrong: Didit moved the hosted flow off the
  // API host and switched to a short-token path, so any synthesized
  // URL lands on a 404. Callers who have the response in scope pass
  // it as `hostedUrl`. Callers reading from the repo (e.g. GET
  // /sessions/:id) get null until `kyc_sessions.verification_url`
  // is added — the firm receives the URL on the create-time
  // response and via the `kyc.session.created` webhook payload, so
  // a null on read is non-blocking for the documented flow.
  const phaseUrl = hostedUrl;

  // Identity phase (always present for the primary session)
  if (session.workflow === 'identity') {
    phases.push({
      phase: 'identity' as const,
      diditSessionId: session.diditSessionId ?? '',
      url: phaseUrl,
      status: mapPhaseStatus(session.status, 'identity'),
      startedAt: session.startedAt.toISOString(),
      completedAt: session.completedAt?.toISOString() ?? null,
    });
  } else {
    phases.push({
      phase: 'address' as const,
      diditSessionId: session.diditSessionId ?? '',
      url: phaseUrl,
      status: mapPhaseStatus(session.status, 'address'),
      startedAt: session.startedAt.toISOString(),
      completedAt: session.completedAt?.toISOString() ?? null,
    });
  }

  return {
    ...sessionToSummary(session),
    redirectUrl: session.callbackUrl,
    metadata: (session.metadata as Record<string, unknown> | null) ?? null,
    expiresAt: session.expiresAt.toISOString(),
    phases,
  };
}

/**
 * Phase-local status the public B2B `SessionPhase.status` field exposes
 * to firms. The 11 internal `kyc_session_status` enum values collapse
 * to 7 firm-facing values (`pending | in_progress | in_review |
 * resubmission_required | approved | rejected | expired`) so firm
 * integrations don't have to track every internal lifecycle state — but
 * non-default outcomes (in_review, resubmission, kyc_expired) DO surface
 * because they need firm-side action: a firm seeing `in_review` should
 * not retrigger the flow, a firm seeing `resubmission_required` should
 * surface the redo prompt, a firm seeing `expired` after a once-approved
 * session knows the credential is no longer trusted.
 *
 * The `revoked`, `kyc_expired`, and `expired` rows all collapse to
 * `expired` from a firm's perspective: each means "treat as not
 * verified, re-verify if you need a fresh credential". The distinction
 * (administrative revoke vs Didit expiration policy vs session timeout)
 * is internal-only and lives on `audit_log` + `webhook_events`.
 */
type PhaseStatus =
  | 'pending'
  | 'in_progress'
  | 'in_review'
  | 'resubmission_required'
  | 'approved'
  | 'rejected'
  | 'expired';

export function mapPhaseStatus(
  sessionStatus: string,
  phase: 'identity' | 'address',
): PhaseStatus {
  if (phase === 'identity') {
    switch (sessionStatus) {
      case 'pending':
        return 'pending';
      case 'in_progress':
        return 'in_progress';
      case 'in_review':
        return 'in_review';
      case 'resubmission_pending':
        return 'resubmission_required';
      case 'identity_approved':
      case 'address_in_progress':
      case 'approved':
        return 'approved';
      case 'rejected':
        return 'rejected';
      case 'expired':
      case 'revoked':
      case 'kyc_expired':
        return 'expired';
      default:
        // Defensive fallback for an unrecognized session status —
        // historically silent `pending` here masked real gaps. Treat
        // the unknown as terminal-failure so firms don't keep
        // re-polling against a stuck session.
        return 'expired';
    }
  }
  // Address phase. Identity-phase-only states (`pending`, `in_progress`,
  // `identity_approved`) project to `pending` for the address phase
  // because the user has not yet started phase 2.
  switch (sessionStatus) {
    case 'pending':
    case 'in_progress':
    case 'identity_approved':
      return 'pending';
    case 'address_in_progress':
      return 'in_progress';
    case 'in_review':
      return 'in_review';
    case 'resubmission_pending':
      return 'resubmission_required';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'expired':
    case 'revoked':
    case 'kyc_expired':
      return 'expired';
    default:
      return 'expired';
  }
}

// Cursor helpers
function encodeCursor(cursor: { ts: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ ts: cursor.ts.toISOString(), id: cursor.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { ts: Date; id: string } | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj['ts'] !== 'string' || typeof obj['id'] !== 'string') return null;
    const ts = new Date(obj['ts']);
    if (Number.isNaN(ts.getTime())) return null;
    return { ts, id: obj['id'] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/sessions — create a new KYC session.
 */
export async function handleCreateSession(ctx: AuthenticatedContext): Promise<NextResponse> {
  const body = await parseBody(ctx.request, SessionCreateRequest);

  // Check for existing active session for this user+workflow
  const existing = await findActiveSessionByUserRef(ctx.db, ctx.firm.id, body.userRef, 'identity');

  if (existing !== null) {
    return ctx.errorJson(
      'conflict',
      `An active KYC session already exists for userRef "${body.userRef}".`,
      409,
    );
  }

  const expiresAt = new Date(ctx.now.getTime() + SESSION_EXPIRY_HOURS * 60 * 60 * 1000);

  // --- Create Didit session ---
  let diditConfig;
  try {
    diditConfig = getDiditConfig();
  } catch {
    return ctx.errorJson(
      'service_unavailable',
      'KYC verification service is currently unavailable.',
      503,
    );
  }

  const vendorDataRaw = JSON.stringify({
    crivacySessionId: crypto.randomUUID(),
    type: 'b2b',
    firmId: ctx.firm.id,
    userRef: body.userRef,
  });
  const vendorData = validateVendorData(vendorDataRaw);

  const webhookUrl = `${getAppUrl()}/api/webhooks/didit`;

  const diditResult = await createKycSession(diditConfig, vendorData, webhookUrl);

  const session = await createSessionRepo(ctx.db, {
    firmId: ctx.firm.id,
    userRef: body.userRef,
    apiKeyId: ctx.apiKey.id,
    workflow: 'identity',
    // `body.level` is already populated by the Zod default in
    // `SessionCreateRequest.level.default('basic')`, so the `??`
    // fallback only matters if the schema is ever bypassed. Pin the
    // fallback to the same default to keep the two paths aligned.
    level: body.level ?? 'basic',
    diditWorkflowId: diditResult.workflowId,
    diditSessionId: diditResult.sessionId,
    callbackUrl: body.redirectUrl ?? null,
    returnUrl: null,
    metadata: body.metadata ?? {},
    expiresAt,
  });

  // `kyc.session.created` fan-out. The session is B2B — firm X
  // initiated it — so the only firm whose user mental model this
  // event belongs to is the calling firm itself. We use
  // `emitFirmEvent` to target exactly that firm's subscriptions,
  // rather than `emitUserEvent` (which would require a Crivacy
  // customer id we don't have at this stage: `userRef` is an
  // opaque firm-local string, not a customers.id uuid).
  try {
    const { emitFirmEvent } = await import('@/lib/webhook');
    const { toSessionWebhookPayload } = await import('@/lib/credentials/view');
    // Pre-mint event — there's no credential row yet, so the payload
    // is built from `KycSessionView` (session-only canonical view) via
    // the central adapter. Once Sprint 5 wires the B2B chain mint
    // pipeline, the post-Approved `kyc.session.approved` event will
    // additionally carry the canonical credential view; this event
    // stays session-shape because the credential genuinely doesn't
    // exist at session-create time.
    await emitFirmEvent(ctx.db, {
      firmId: ctx.firm.id,
      type: 'kyc.session.created',
      payload: {
        ...toSessionWebhookPayload({
          sessionId: session.id,
          userRef: session.userRef,
          workflow: session.workflow,
          level: session.level,
          verificationUrl: diditResult.sessionUrl ?? null,
          expiresAt: session.expiresAt,
          createdAt: session.createdAt,
        }),
      },
      sourceSessionId: session.id,
      idempotencyKey: `kyc.session.created:${session.id}`,
      now: ctx.now,
    });
  } catch (webhookErr) {
    // Session is already persisted — a failed webhook must not
    // reject the API call. Log and continue.
    getRootLogger().error(
      {
        event: 'sessions_kyc_created_dispatch_failed',
        err: webhookErr instanceof Error
          ? { name: webhookErr.name, message: webhookErr.message }
          : String(webhookErr),
      },
      'kyc.session.created dispatch failed',
    );
  }

  return ctx.json(sessionToDetail(session, diditResult.sessionUrl ?? null), 201);
}

/**
 * GET /api/v1/sessions/:id — read a session by ID.
 */
export async function handleGetSession(
  ctx: AuthenticatedContext,
  params: Promise<Record<string, string | string[]>>,
): Promise<NextResponse> {
  const { id } = await parsePathParams(params, PathIdParams);

  const session = await findSessionById(ctx.db, ctx.firm.id, id);
  if (session === null) {
    return ctx.errorJson('not_found', `Session "${id}" not found.`, 404);
  }

  return ctx.json(sessionToDetail(session));
}

/**
 * DELETE /api/v1/sessions/:id — cancel a session.
 */
export async function handleCancelSession(
  ctx: AuthenticatedContext,
  params: Promise<Record<string, string | string[]>>,
): Promise<NextResponse> {
  const { id } = await parsePathParams(params, PathIdParams);

  const session = await findSessionById(ctx.db, ctx.firm.id, id);
  if (session === null) {
    return ctx.errorJson('not_found', `Session "${id}" not found.`, 404);
  }

  // Terminal states: approved, rejected, expired, revoked
  const terminalStates = new Set(['approved', 'rejected', 'expired', 'revoked']);
  if (terminalStates.has(session.status)) {
    // Idempotent — already terminal, return 204
    return ctx.noContent();
  }

  await cancelSessionRepo(ctx.db, ctx.firm.id, id, ctx.now);
  return ctx.noContent();
}

/**
 * GET /api/v1/sessions — list sessions (paginated).
 */
export async function handleListSessions(ctx: AuthenticatedContext): Promise<NextResponse> {
  const url = new URL(ctx.request.url);
  const query = parseQuery(
    url,
    PaginationQuery.extend({
      status: z.string().optional(),
      userRef: z.string().optional(),
      createdAfter: z.string().optional(),
      createdBefore: z.string().optional(),
    }),
  );

  const cursor = query.cursor !== undefined ? decodeCursor(query.cursor) : null;

  let filters: SessionListFilters = {
    firmId: ctx.firm.id,
    limit: query.limit ?? 25,
  };
  if (query.status !== undefined) filters = { ...filters, status: query.status };
  if (query.userRef !== undefined) filters = { ...filters, userRef: query.userRef };
  if (query.createdAfter !== undefined)
    filters = { ...filters, createdAfter: new Date(query.createdAfter) };
  if (query.createdBefore !== undefined)
    filters = { ...filters, createdBefore: new Date(query.createdBefore) };
  if (cursor !== null) filters = { ...filters, cursor };

  const result = await listSessions(ctx.db, filters);

  return ctx.json({
    data: result.items.map(sessionToSummary),
    pagination: {
      nextCursor: result.nextCursor !== null ? encodeCursor(result.nextCursor) : null,
      limit: query.limit ?? 25,
    },
  });
}
