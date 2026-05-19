/**
 * Admin status handlers — status components CRUD, incident management.
 *
 * @module
 */

import type { CrivacyDatabase } from '@/lib/db/client';

import type { AdminContext } from '../context';
import type { AdminStatusComponentRow, AdminStatusIncidentRow } from '../repositories/admin';

/* ---------- Deps ---------- */

export interface AdminStatusDeps {
  readonly listComponents: (db: CrivacyDatabase) => Promise<readonly AdminStatusComponentRow[]>;
  readonly createComponent: (
    db: CrivacyDatabase,
    input: {
      readonly slug: string;
      readonly name: string;
      readonly description?: string | undefined;
      readonly groupName?: string | undefined;
      readonly position?: number | undefined;
    },
  ) => Promise<{ id: string }>;
  readonly updateComponent: (
    db: CrivacyDatabase,
    componentId: string,
    updates: {
      readonly name?: string | undefined;
      readonly description?: string | undefined;
      readonly groupName?: string | undefined;
      readonly position?: number | undefined;
      readonly currentState?: string | undefined;
      readonly manualOverride?: boolean | undefined;
      readonly manualOverrideReason?: string | undefined;
    },
    adminUserId: string,
  ) => Promise<AdminStatusComponentRow | null>;
  readonly listIncidents: (
    db: CrivacyDatabase,
    opts?: {
      readonly status?: string | undefined;
      readonly limit?: number | undefined;
      readonly offset?: number | undefined;
    },
  ) => Promise<{ incidents: readonly AdminStatusIncidentRow[]; total: number }>;
  readonly createIncident: (
    db: CrivacyDatabase,
    input: {
      readonly title: string;
      readonly body: string;
      readonly severity: string;
      readonly status?: string | undefined;
      readonly componentIds?: string[] | undefined;
      readonly published?: boolean | undefined;
      readonly createdBy: string;
    },
  ) => Promise<{ id: string }>;
  readonly updateIncident: (
    db: CrivacyDatabase,
    incidentId: string,
    updates: {
      readonly status?: string | undefined;
      readonly body?: string | undefined;
      readonly published?: boolean | undefined;
      readonly resolvedAt?: Date | undefined;
      readonly identifiedAt?: Date | undefined;
      readonly monitoringAt?: Date | undefined;
    },
  ) => Promise<AdminStatusIncidentRow | null>;
  readonly addTimelineUpdate: (
    db: CrivacyDatabase,
    incidentId: string,
    update: { readonly at: string; readonly status: string; readonly body: string },
  ) => Promise<void>;
}

/* ---------- Components ---------- */

export async function handleListComponents(
  deps: AdminStatusDeps,
  ctx: AdminContext,
): Promise<readonly AdminStatusComponentRow[]> {
  return deps.listComponents(ctx.db);
}

export interface CreateComponentInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly groupName?: string | undefined;
  readonly position?: number | undefined;
}

export async function handleCreateComponent(
  deps: AdminStatusDeps,
  ctx: AdminContext,
  input: CreateComponentInput,
): Promise<{ id: string }> {
  return deps.createComponent(ctx.db, input);
}

export interface UpdateComponentInput {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly groupName?: string | undefined;
  readonly position?: number | undefined;
  readonly currentState?: string | undefined;
  readonly manualOverride?: boolean | undefined;
  readonly manualOverrideReason?: string | undefined;
}

export async function handleUpdateComponent(
  deps: AdminStatusDeps,
  ctx: AdminContext,
  componentId: string,
  input: UpdateComponentInput,
): Promise<AdminStatusComponentRow | null> {
  return deps.updateComponent(ctx.db, componentId, input, ctx.user.id);
}

/* ---------- Incidents ---------- */

export interface ListIncidentsInput {
  readonly status?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export async function handleListIncidents(
  deps: AdminStatusDeps,
  ctx: AdminContext,
  input: ListIncidentsInput = {},
): Promise<{ incidents: readonly AdminStatusIncidentRow[]; total: number }> {
  return deps.listIncidents(ctx.db, input);
}

export interface CreateIncidentInput {
  readonly title: string;
  readonly body: string;
  readonly severity: string;
  readonly status?: string | undefined;
  readonly componentIds?: string[] | undefined;
  readonly published?: boolean | undefined;
}

export async function handleCreateIncident(
  deps: AdminStatusDeps,
  ctx: AdminContext,
  input: CreateIncidentInput,
): Promise<{ id: string }> {
  return deps.createIncident(ctx.db, {
    ...input,
    createdBy: ctx.user.id,
  });
}

export interface UpdateIncidentInput {
  readonly status?: string | undefined;
  readonly body?: string | undefined;
  readonly published?: boolean | undefined;
  readonly resolvedAt?: Date | undefined;
  readonly identifiedAt?: Date | undefined;
  readonly monitoringAt?: Date | undefined;
}

export async function handleUpdateIncident(
  deps: AdminStatusDeps,
  ctx: AdminContext,
  incidentId: string,
  input: UpdateIncidentInput,
): Promise<AdminStatusIncidentRow | null> {
  return deps.updateIncident(ctx.db, incidentId, input);
}

export interface AddTimelineUpdateInput {
  readonly status: string;
  readonly body: string;
}

export async function handleAddTimelineUpdate(
  deps: AdminStatusDeps,
  ctx: AdminContext,
  incidentId: string,
  input: AddTimelineUpdateInput,
): Promise<void> {
  await deps.addTimelineUpdate(ctx.db, incidentId, {
    at: ctx.now.toISOString(),
    status: input.status,
    body: input.body,
  });
}
