/**
 * Public status handler tests.
 */

import { describe, expect, it, vi } from 'vitest';

import type { RequestContext } from '@/server/context';
import { handleStatusCheck } from '@/server/handlers/health';
import type { StatusDeps } from '@/server/handlers/health';
import type { PublicComponentRow, PublicIncidentRow } from '@/server/repositories/status';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-12T12:00:00Z');

function buildCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: 'req-1',
    db: {} as RequestContext['db'],
    now: NOW,
    startedAt: 0,
    ip: '127.0.0.1',
    userAgent: 'test',
    method: 'GET',
    path: '/api/v1/status',
    request: {} as RequestContext['request'],
    json: vi.fn((body, status = 200) => {
      return { body, status } as unknown as ReturnType<RequestContext['json']>;
    }),
    noContent: vi.fn(() => ({}) as unknown as ReturnType<RequestContext['noContent']>),
    errorJson: vi.fn((code, message, status) => {
      return { code, message, status } as unknown as ReturnType<RequestContext['errorJson']>;
    }),
    ...overrides,
  } as RequestContext;
}

function buildComponentRow(overrides: Partial<PublicComponentRow> = {}): PublicComponentRow {
  return {
    id: overrides.id ?? 'c1',
    slug: overrides.slug ?? 'api',
    name: overrides.name ?? 'API',
    description: overrides.description ?? 'Public API',
    groupName: overrides.groupName ?? 'core',
    currentState: overrides.currentState ?? 'operational',
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function buildIncidentRow(overrides: Partial<PublicIncidentRow> = {}): PublicIncidentRow {
  return {
    id: overrides.id ?? 'inc-1',
    title: overrides.title ?? 'API Degradation',
    body: overrides.body ?? 'Elevated error rates.',
    severity: overrides.severity ?? 'minor',
    status: overrides.status ?? 'investigating',
    componentIds: overrides.componentIds ?? ['c1'],
    updatesTimeline: overrides.updatesTimeline ?? [],
    startedAt: overrides.startedAt ?? NOW,
    identifiedAt: overrides.identifiedAt ?? null,
    monitoringAt: overrides.monitoringAt ?? null,
    resolvedAt: overrides.resolvedAt ?? null,
  };
}

function buildDeps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    listComponents: overrides.listComponents ?? vi.fn(async () => []),
    listIncidents: overrides.listIncidents ?? vi.fn(async () => []),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleStatusCheck', () => {
  it('returns operational with empty components', async () => {
    const ctx = buildCtx();
    const deps = buildDeps();
    await handleStatusCheck(deps, ctx);
    expect(ctx.json).toHaveBeenCalledOnce();
    const body = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body['overall']).toBe('operational');
    expect(body['components']).toEqual([]);
    expect(body['activeIncidents']).toEqual([]);
    expect(typeof body['generatedAt']).toBe('string');
  });

  it('returns components from DB', async () => {
    const ctx = buildCtx();
    const deps = buildDeps({
      listComponents: vi.fn(async () => [
        buildComponentRow({ id: 'c1', slug: 'api', currentState: 'operational' }),
        buildComponentRow({
          id: 'c2',
          slug: 'ledger',
          currentState: 'degraded',
          groupName: 'infra',
        }),
      ]),
    });
    await handleStatusCheck(deps, ctx);
    const body = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const components = body['components'] as Array<Record<string, unknown>>;
    expect(components.length).toBe(2);
    expect(components[0]?.['slug']).toBe('api');
    expect(components[1]?.['slug']).toBe('ledger');
  });

  it('computes overall as worst state', async () => {
    const ctx = buildCtx();
    const deps = buildDeps({
      listComponents: vi.fn(async () => [
        buildComponentRow({ id: 'c1', currentState: 'operational' }),
        buildComponentRow({ id: 'c2', currentState: 'major_outage' }),
      ]),
    });
    await handleStatusCheck(deps, ctx);
    const body = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body['overall']).toBe('major_outage');
  });

  it('returns active incidents', async () => {
    const ctx = buildCtx();
    const deps = buildDeps({
      listIncidents: vi.fn(async () => [
        buildIncidentRow({
          title: 'Outage',
          updatesTimeline: [
            { at: '2026-04-12T10:00:00Z', status: 'investigating', body: 'Looking into it.' },
          ],
        }),
      ]),
    });
    await handleStatusCheck(deps, ctx);
    const body = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const incidents = body['activeIncidents'] as Array<Record<string, unknown>>;
    expect(incidents.length).toBe(1);
    expect(incidents[0]?.['title']).toBe('Outage');
    const updates = incidents[0]?.['updates'] as Array<Record<string, unknown>>;
    expect(updates.length).toBe(1);
    expect(updates[0]?.['body']).toBe('Looking into it.');
  });

  it('handles malformed updatesTimeline gracefully', async () => {
    const ctx = buildCtx();
    const deps = buildDeps({
      listIncidents: vi.fn(async () => [
        buildIncidentRow({
          updatesTimeline: 'not-an-array' as unknown,
        }),
      ]),
    });
    await handleStatusCheck(deps, ctx);
    const body = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const incidents = body['activeIncidents'] as Array<Record<string, unknown>>;
    expect(incidents[0]?.['updates']).toEqual([]);
  });

  it('filters invalid timeline entries', async () => {
    const ctx = buildCtx();
    const deps = buildDeps({
      listIncidents: vi.fn(async () => [
        buildIncidentRow({
          updatesTimeline: [
            { at: '2026-04-12T10:00:00Z', status: 'identified', body: 'Valid' },
            { bad: 'entry' },
            null,
            42,
          ],
        }),
      ]),
    });
    await handleStatusCheck(deps, ctx);
    const body = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const incidents = body['activeIncidents'] as Array<Record<string, unknown>>;
    const updates = incidents[0]?.['updates'] as Array<Record<string, unknown>>;
    expect(updates.length).toBe(1);
    expect(updates[0]?.['body']).toBe('Valid');
  });

  it('maps component fields correctly', async () => {
    const ctx = buildCtx();
    const deps = buildDeps({
      listComponents: vi.fn(async () => [
        buildComponentRow({
          id: 'c1',
          slug: 'api',
          name: 'API',
          description: 'Public API',
          groupName: 'core',
          currentState: 'degraded',
          updatedAt: NOW,
        }),
      ]),
    });
    await handleStatusCheck(deps, ctx);
    const body = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const components = body['components'] as Array<Record<string, unknown>>;
    const c = components[0];
    expect(c?.['id']).toBe('c1');
    expect(c?.['slug']).toBe('api');
    expect(c?.['name']).toBe('API');
    expect(c?.['description']).toBe('Public API');
    expect(c?.['group']).toBe('core');
    expect(c?.['state']).toBe('degraded');
    expect(typeof c?.['updatedAt']).toBe('string');
  });

  it('maps incident fields correctly', async () => {
    const resolved = new Date('2026-04-12T14:00:00Z');
    const ctx = buildCtx();
    const deps = buildDeps({
      listIncidents: vi.fn(async () => [
        buildIncidentRow({
          id: 'inc-1',
          title: 'Outage',
          body: 'Description',
          severity: 'critical',
          status: 'resolved',
          componentIds: ['c1', 'c2'],
          startedAt: NOW,
          resolvedAt: resolved,
          identifiedAt: NOW,
          monitoringAt: NOW,
        }),
      ]),
    });
    await handleStatusCheck(deps, ctx);
    const body = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const incidents = body['activeIncidents'] as Array<Record<string, unknown>>;
    const inc = incidents[0];
    expect(inc?.['id']).toBe('inc-1');
    expect(inc?.['title']).toBe('Outage');
    expect(inc?.['severity']).toBe('critical');
    expect(inc?.['status']).toBe('resolved');
    expect(inc?.['componentIds']).toEqual(['c1', 'c2']);
    expect(inc?.['resolvedAt']).toBe(resolved.toISOString());
    expect(inc?.['identifiedAt']).toBe(NOW.toISOString());
    expect(inc?.['monitoringAt']).toBe(NOW.toISOString());
  });

  it('generatedAt is from ctx.now', async () => {
    const ctx = buildCtx();
    const deps = buildDeps();
    await handleStatusCheck(deps, ctx);
    const body = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body['generatedAt']).toBe(NOW.toISOString());
  });
});
