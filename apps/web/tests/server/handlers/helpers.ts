/**
 * Test helpers for handler tests.
 *
 * Builds fake AuthenticatedContext / RequestContext instances that
 * carry a mock DB and deterministic clock. The contexts expose the
 * real `json` / `errorJson` / `noContent` helpers from context.ts
 * so assertions on the response body and status are straightforward.
 */

import { NextRequest } from 'next/server';

import type { ApiKeyScope } from '@crivacy/shared-types';

import {
  type AuthenticatedContext,
  type RequestContext,
  buildAuthenticatedContext,
  buildRequestContext,
} from '@/server/context';

import {
  FIXTURE_API_KEY_ID,
  FIXTURE_FIRM_ID,
  FIXTURE_NOW,
  FIXTURE_REQUEST_ID,
  buildMockDb,
  buildResolvedApiKey,
  buildResolvedFirm,
  fixtureClock,
  fixtureRequestIdFactory,
} from '../fixtures';

/* ---------- Authenticated context builder ---------- */

export interface AuthCtxOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  scopes?: readonly ApiKeyScope[];
  tier?: 'free' | 'starter' | 'pro' | 'enterprise';
}

export function buildAuthCtx(opts: AuthCtxOptions = {}): AuthenticatedContext {
  const method = opts.method ?? 'GET';
  const url = opts.url ?? 'https://api.crivacy.test/api/v1/sessions';
  const headers = new Headers(opts.headers ?? {});

  const requestInit: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    requestInit.body = opts.body;
    headers.set('content-type', 'application/json');
  }

  const request = new NextRequest(new Request(url, requestInit));
  const db = buildMockDb();
  const base = buildRequestContext(request, db, fixtureClock, fixtureRequestIdFactory);
  const apiKey = buildResolvedApiKey({
    scopes: opts.scopes ?? [
      'kyc:create',
      'kyc:read',
      'kyc:verify',
      'webhooks:manage',
      'usage:read',
    ],
  });
  const firm = buildResolvedFirm({
    tier: opts.tier ?? 'starter',
  });

  return buildAuthenticatedContext(base, apiKey, firm, {
    limit: 100,
    remaining: 42,
    resetSeconds: 60,
  });
}

/* ---------- Request context builder (for public/webhook routes) ---------- */

export function buildReqCtx(opts: { method?: string; url?: string } = {}): RequestContext {
  const method = opts.method ?? 'GET';
  const url = opts.url ?? 'https://api.crivacy.test/api/v1/health';
  const request = new NextRequest(new Request(url, { method }));
  const db = buildMockDb();
  return buildRequestContext(request, db, fixtureClock, fixtureRequestIdFactory);
}

/* ---------- Re-exports ---------- */
export { FIXTURE_API_KEY_ID, FIXTURE_FIRM_ID, FIXTURE_NOW, FIXTURE_REQUEST_ID, buildMockDb };
