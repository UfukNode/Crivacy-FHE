/**
 * Admin status handler tests — components and incidents CRUD.
 */

import { describe, expect, it, vi } from 'vitest';

import type { AdminStatusDeps } from '@/server/handlers/admin-status';
import {
  handleAddTimelineUpdate,
  handleCreateComponent,
  handleCreateIncident,
  handleListComponents,
  handleListIncidents,
  handleUpdateComponent,
  handleUpdateIncident,
} from '@/server/handlers/admin-status';
import type { AdminStatusComponentRow, AdminStatusIncidentRow } from '@/server/repositories/admin';

import { FIXTURE_NOW, buildAdminCtx } from './admin-helpers';

/* ---------- Fixture builders ---------- */

const FIXTURE_COMPONENT_ID = 'sc111111-1111-4111-8111-111111111111';
const FIXTURE_INCIDENT_ID = 'si111111-1111-4111-8111-111111111111';

function buildComponentRow(
  overrides: Partial<AdminStatusComponentRow> = {},
): AdminStatusComponentRow {
  return {
    id: FIXTURE_COMPONENT_ID,
    slug: 'api-gateway',
    name: 'API Gateway',
    description: null,
    groupName: 'Core',
    position: 0,
    currentState: 'operational',
    manualOverride: false,
    manualOverrideReason: null,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

function buildIncidentRow(overrides: Partial<AdminStatusIncidentRow> = {}): AdminStatusIncidentRow {
  return {
    id: FIXTURE_INCIDENT_ID,
    title: 'API latency spike',
    body: 'Investigating elevated response times.',
    severity: 'minor',
    status: 'investigating',
    componentIds: [FIXTURE_COMPONENT_ID],
    updatesTimeline: [],
    published: true,
    startedAt: FIXTURE_NOW,
    resolvedAt: null,
    createdBy: 'a1111111-1111-4111-8111-111111111111',
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

function buildDeps(overrides: Partial<AdminStatusDeps> = {}): AdminStatusDeps {
  return {
    listComponents: vi.fn().mockResolvedValue([buildComponentRow()]),
    createComponent: vi.fn().mockResolvedValue({ id: FIXTURE_COMPONENT_ID }),
    updateComponent: vi.fn().mockResolvedValue(buildComponentRow({ currentState: 'degraded' })),
    listIncidents: vi.fn().mockResolvedValue({ incidents: [buildIncidentRow()], total: 1 }),
    createIncident: vi.fn().mockResolvedValue({ id: FIXTURE_INCIDENT_ID }),
    updateIncident: vi.fn().mockResolvedValue(buildIncidentRow({ status: 'identified' })),
    addTimelineUpdate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/* ---------- Component tests ---------- */

describe('handleListComponents', () => {
  it('returns all components', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const result = await handleListComponents(deps, ctx);

    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe('api-gateway');
    expect(deps.listComponents).toHaveBeenCalledWith(ctx.db);
  });
});

describe('handleCreateComponent', () => {
  it('creates a component and returns id', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const input = { slug: 'auth-service', name: 'Auth Service' };
    const result = await handleCreateComponent(deps, ctx, input);

    expect(result.id).toBe(FIXTURE_COMPONENT_ID);
    expect(deps.createComponent).toHaveBeenCalledWith(ctx.db, input);
  });

  it('passes optional fields through', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const input = {
      slug: 'db',
      name: 'Database',
      description: 'PostgreSQL 16',
      groupName: 'Infrastructure',
      position: 5,
    };
    await handleCreateComponent(deps, ctx, input);

    expect(deps.createComponent).toHaveBeenCalledWith(ctx.db, input);
  });
});

describe('handleUpdateComponent', () => {
  it('updates component and passes adminUserId', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const result = await handleUpdateComponent(deps, ctx, FIXTURE_COMPONENT_ID, {
      currentState: 'degraded',
      manualOverride: true,
      manualOverrideReason: 'Testing',
    });

    expect(result?.currentState).toBe('degraded');
    expect(deps.updateComponent).toHaveBeenCalledWith(
      ctx.db,
      FIXTURE_COMPONENT_ID,
      { currentState: 'degraded', manualOverride: true, manualOverrideReason: 'Testing' },
      ctx.user.id,
    );
  });

  it('returns null when component not found', async () => {
    const deps = buildDeps({ updateComponent: vi.fn().mockResolvedValue(null) });
    const ctx = buildAdminCtx();
    const result = await handleUpdateComponent(deps, ctx, 'nonexistent', { name: 'X' });

    expect(result).toBeNull();
  });
});

/* ---------- Incident tests ---------- */

describe('handleListIncidents', () => {
  it('returns incidents with total', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const result = await handleListIncidents(deps, ctx, {});

    expect(result.incidents).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('passes filter opts through', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    await handleListIncidents(deps, ctx, { status: 'resolved', limit: 10, offset: 5 });

    expect(deps.listIncidents).toHaveBeenCalledWith(ctx.db, {
      status: 'resolved',
      limit: 10,
      offset: 5,
    });
  });
});

describe('handleCreateIncident', () => {
  it('creates incident with createdBy from context user', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const input = {
      title: 'Outage',
      body: 'Major outage detected.',
      severity: 'critical',
    };
    const result = await handleCreateIncident(deps, ctx, input);

    expect(result.id).toBe(FIXTURE_INCIDENT_ID);
    expect(deps.createIncident).toHaveBeenCalledWith(ctx.db, {
      ...input,
      createdBy: ctx.user.id,
    });
  });

  it('passes optional fields through', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const input = {
      title: 'Maintenance',
      body: 'Scheduled downtime.',
      severity: 'minor',
      status: 'monitoring',
      componentIds: [FIXTURE_COMPONENT_ID],
      published: false,
    };
    await handleCreateIncident(deps, ctx, input);

    expect(deps.createIncident).toHaveBeenCalledWith(ctx.db, {
      ...input,
      createdBy: ctx.user.id,
    });
  });
});

describe('handleUpdateIncident', () => {
  it('updates incident and returns row', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    const result = await handleUpdateIncident(deps, ctx, FIXTURE_INCIDENT_ID, {
      status: 'identified',
    });

    expect(result?.status).toBe('identified');
    expect(deps.updateIncident).toHaveBeenCalledWith(ctx.db, FIXTURE_INCIDENT_ID, {
      status: 'identified',
    });
  });

  it('returns null when incident not found', async () => {
    const deps = buildDeps({ updateIncident: vi.fn().mockResolvedValue(null) });
    const ctx = buildAdminCtx();
    const result = await handleUpdateIncident(deps, ctx, 'nonexistent', { status: 'resolved' });

    expect(result).toBeNull();
  });
});

describe('handleAddTimelineUpdate', () => {
  it('adds timeline update with current timestamp from context', async () => {
    const deps = buildDeps();
    const ctx = buildAdminCtx();
    await handleAddTimelineUpdate(deps, ctx, FIXTURE_INCIDENT_ID, {
      status: 'monitoring',
      body: 'Fix deployed, monitoring.',
    });

    expect(deps.addTimelineUpdate).toHaveBeenCalledWith(ctx.db, FIXTURE_INCIDENT_ID, {
      at: ctx.now.toISOString(),
      status: 'monitoring',
      body: 'Fix deployed, monitoring.',
    });
  });
});
