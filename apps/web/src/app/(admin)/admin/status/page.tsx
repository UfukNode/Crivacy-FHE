'use client';

import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { StatusBadge } from '@/components/shared/status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingButton } from '@/components/shared/loading-button';
import { RelativeTime } from '@/components/shared/relative-time';
import { useAdminPermissions } from '@/hooks/use-admin-permissions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatusComponent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  groupName: string | null;
  position: number;
  currentState: string;
  manualOverride: boolean;
  manualOverrideReason: string | null;
}

interface Incident {
  id: string;
  title: string;
  body: string;
  severity: string;
  status: string;
  componentIds: string[];
  published: boolean;
  startedAt: string;
  resolvedAt: string | null;
  createdAt: string;
}

interface ComponentsResponse {
  components: StatusComponent[];
}

interface IncidentsResponse {
  incidents: Incident[];
  total: number;
}

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

const STATE_STATUS_MAP: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  operational: 'success',
  degraded: 'warning',
  partial_outage: 'warning',
  major_outage: 'danger',
  maintenance: 'info',
};

const STATE_LABELS: Record<string, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  partial_outage: 'Partial Outage',
  major_outage: 'Major Outage',
  maintenance: 'Maintenance',
};

const SEVERITY_VARIANT: Record<string, 'secondary' | 'warning' | 'destructive'> = {
  minor: 'secondary',
  major: 'warning',
  critical: 'destructive',
};

const STATUS_LABELS: Record<string, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};

const COMPONENT_STATES = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance'] as const;
const INCIDENT_SEVERITIES = ['minor', 'major', 'critical'] as const;
const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;

// ---------------------------------------------------------------------------
// Cookie-based mutation helper (reads use the SWR fetcher from layout)
// ---------------------------------------------------------------------------

async function adminMutate(path: string, init: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminStatusPage() {
  // Permission-based gates. Components and incidents are separately
  // gated on the API side, mirror that on the UI so buttons disappear
  // instead of returning 403 toasts.
  const { has: hasAdminPermission } = useAdminPermissions();
  const canManageComponents = hasAdminPermission('admin.status.component_manage');
  const canManageIncidents = hasAdminPermission('admin.status.incident_manage');

  // SWR for components + incidents
  const {
    data: compData,
    error: compError,
    isLoading: compLoading,
    mutate: mutateComponents,
  } = useSWR<ComponentsResponse>('/api/internal/admin/status/components');

  const {
    data: incData,
    error: incError,
    isLoading: incLoading,
    mutate: mutateIncidents,
  } = useSWR<IncidentsResponse>('/api/internal/admin/status/incidents');

  const components = compData?.components ?? [];
  const incidents = incData?.incidents ?? [];

  // Create component dialog
  const [createCompOpen, setCreateCompOpen] = useState(false);
  const [compSlug, setCompSlug] = useState('');
  const [compName, setCompName] = useState('');
  const [compGroup, setCompGroup] = useState('');
  const [compSaving, setCompSaving] = useState(false);

  // Create incident dialog
  const [createIncOpen, setCreateIncOpen] = useState(false);
  const [incTitle, setIncTitle] = useState('');
  const [incBody, setIncBody] = useState('');
  const [incSeverity, setIncSeverity] = useState('minor');
  const [incSaving, setIncSaving] = useState(false);

  // Refresh all
  const refreshAll = useCallback(() => {
    void mutateComponents();
    void mutateIncidents();
  }, [mutateComponents, mutateIncidents]);

  // Update component state
  const handleUpdateState = useCallback(async (id: string, state: string) => {
    try {
      const res = await adminMutate(`/api/internal/admin/status/components/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          currentState: state,
          manualOverride: true,
          manualOverrideReason: 'Admin manual update',
        }),
      });
      if (!res.ok) {
        toast.error('Failed to update component status.');
        return;
      }
      toast.success('Component status updated.');
      void mutateComponents();
    } catch {
      toast.error('Network error.');
    }
  }, [mutateComponents]);

  // Create component
  const handleCreateComponent = useCallback(async () => {
    setCompSaving(true);
    try {
      const res = await adminMutate('/api/internal/admin/status/components', {
        method: 'POST',
        body: JSON.stringify({
          slug: compSlug,
          name: compName,
          ...(compGroup.length > 0 ? { groupName: compGroup } : {}),
        }),
      });
      if (!res.ok) {
        toast.error('Failed to create component.');
        return;
      }
      toast.success('Component created.');
      setCreateCompOpen(false);
      setCompSlug('');
      setCompName('');
      setCompGroup('');
      void mutateComponents();
    } catch {
      toast.error('Network error.');
    } finally {
      setCompSaving(false);
    }
  }, [compSlug, compName, compGroup, mutateComponents]);

  // Create incident
  const handleCreateIncident = useCallback(async () => {
    setIncSaving(true);
    try {
      const res = await adminMutate('/api/internal/admin/status/incidents', {
        method: 'POST',
        body: JSON.stringify({ title: incTitle, body: incBody, severity: incSeverity }),
      });
      if (!res.ok) {
        toast.error('Failed to create incident.');
        return;
      }
      toast.success('Incident published.');
      setCreateIncOpen(false);
      setIncTitle('');
      setIncBody('');
      setIncSeverity('minor');
      void mutateIncidents();
    } catch {
      toast.error('Network error.');
    } finally {
      setIncSaving(false);
    }
  }, [incTitle, incBody, incSeverity, mutateIncidents]);

  // Update incident status
  const handleUpdateIncidentStatus = useCallback(async (id: string, status: string) => {
    try {
      const res = await adminMutate(`/api/internal/admin/status/incidents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        toast.error('Failed to update incident.');
        return;
      }
      toast.success('Incident updated.');
      void mutateIncidents();
    } catch {
      toast.error('Network error.');
    }
  }, [mutateIncidents]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Status Page"
        description="Manage service components and incidents"
        actions={
          <Button variant="outline" size="sm" onClick={refreshAll}>
            Refresh
          </Button>
        }
      />

      <Tabs defaultValue="components">
        <TabsList>
          <TabsTrigger value="components">
            Components ({components.length})
          </TabsTrigger>
          <TabsTrigger value="incidents">
            Incidents ({incidents.length})
          </TabsTrigger>
        </TabsList>

        {/* ---------------------------------------------------------------- */}
        {/* Components Tab                                                    */}
        {/* ---------------------------------------------------------------- */}
        <TabsContent value="components" className="space-y-4">
          {canManageComponents && (
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setCreateCompOpen(true)}>
                <Plus className="h-4 w-4" />
                Add Component
              </Button>
            </div>
          )}

          {/* Error */}
          {compError && !compLoading && (
            <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3">
              <p className="flex-1 text-sm text-[var(--color-danger)]">
                Failed to load components.
              </p>
              <Button variant="outline" size="sm" onClick={() => void mutateComponents()}>
                Retry
              </Button>
            </div>
          )}

          {/* Loading */}
          {compLoading && (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-3 w-3 rounded-full" />
                      <div className="space-y-1">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-3 w-20" />
                      </div>
                    </div>
                    <Skeleton className="h-8 w-32" />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Component list */}
          {!compLoading && components.length > 0 && (
            <div className="space-y-2">
              {components.map((comp) => (
                <Card key={comp.id}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <StatusBadge status={STATE_STATUS_MAP[comp.currentState] ?? 'neutral'}>
                        {STATE_LABELS[comp.currentState] ?? comp.currentState}
                      </StatusBadge>
                      <div>
                        <span className="font-medium text-[var(--color-fg)]">{comp.name}</span>
                        <span className="ml-2 font-mono text-xs text-[var(--color-muted)]">
                          {comp.slug}
                        </span>
                        {comp.groupName !== null && (
                          <span className="ml-2 text-xs text-[var(--color-muted)]">
                            [{comp.groupName}]
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {canManageComponents ? (
                        <Select
                          value={comp.currentState}
                          onValueChange={(value) => void handleUpdateState(comp.id, value)}
                        >
                          <SelectTrigger className="h-8 w-40 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {COMPONENT_STATES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {STATE_LABELS[s] ?? s}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="outline" className="h-8 text-xs capitalize">
                          {STATE_LABELS[comp.currentState] ?? comp.currentState}
                        </Badge>
                      )}
                      {comp.manualOverride && (
                        <Badge variant="warning" className="text-xs">Manual</Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Empty */}
          {!compLoading && !compError && components.length === 0 && (
            <EmptyState
              title="No components configured"
              description={
                canManageComponents
                  ? 'Add a component to start tracking service status.'
                  : 'No service components have been configured yet.'
              }
              {...(canManageComponents
                ? {
                    action: (
                      <Button size="sm" onClick={() => setCreateCompOpen(true)}>
                        <Plus className="h-4 w-4" />
                        Add Component
                      </Button>
                    ),
                  }
                : {})}
            />
          )}
        </TabsContent>

        {/* ---------------------------------------------------------------- */}
        {/* Incidents Tab                                                     */}
        {/* ---------------------------------------------------------------- */}
        <TabsContent value="incidents" className="space-y-4">
          {canManageIncidents && (
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setCreateIncOpen(true)}>
                <Plus className="h-4 w-4" />
                Publish Incident
              </Button>
            </div>
          )}

          {/* Error */}
          {incError && !incLoading && (
            <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3">
              <p className="flex-1 text-sm text-[var(--color-danger)]">
                Failed to load incidents.
              </p>
              <Button variant="outline" size="sm" onClick={() => void mutateIncidents()}>
                Retry
              </Button>
            </div>
          )}

          {/* Loading */}
          {incLoading && (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i}>
                  <CardHeader>
                    <Skeleton className="h-5 w-48" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="mt-2 h-4 w-2/3" />
                    <div className="mt-3 flex items-center gap-3">
                      <Skeleton className="h-5 w-16 rounded-full" />
                      <Skeleton className="h-5 w-24" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Incident list */}
          {!incLoading && incidents.length > 0 && (
            <div className="space-y-3">
              {incidents.map((inc) => (
                <Card key={inc.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <CardTitle className="text-base">{inc.title}</CardTitle>
                      <div className="flex items-center gap-2">
                        <Badge variant={SEVERITY_VARIANT[inc.severity] ?? 'secondary'}>
                          {inc.severity.toUpperCase()}
                        </Badge>
                        {!inc.published && (
                          <Badge variant="outline">Draft</Badge>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-[var(--color-muted)]">{inc.body}</p>
                    <div className="mt-3 flex items-center justify-between">
                      <div className="flex items-center gap-3 text-xs text-[var(--color-muted)]">
                        <span>{STATUS_LABELS[inc.status] ?? inc.status}</span>
                        <span>
                          Started: <RelativeTime date={inc.startedAt} />
                        </span>
                        {inc.resolvedAt !== null && (
                          <span>
                            Resolved: <RelativeTime date={inc.resolvedAt} />
                          </span>
                        )}
                      </div>
                      {canManageIncidents ? (
                        <Select
                          value={inc.status}
                          onValueChange={(value) => void handleUpdateIncidentStatus(inc.id, value)}
                        >
                          <SelectTrigger className="h-8 w-36 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {INCIDENT_STATUSES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {STATUS_LABELS[s] ?? s}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="outline" className="h-8 text-xs">
                          {STATUS_LABELS[inc.status] ?? inc.status}
                        </Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Empty */}
          {!incLoading && !incError && incidents.length === 0 && (
            <EmptyState
              title="No incidents"
              description="All systems are running smoothly."
              {...(canManageIncidents
                ? {
                    action: (
                      <Button size="sm" onClick={() => setCreateIncOpen(true)}>
                        <Plus className="h-4 w-4" />
                        Publish Incident
                      </Button>
                    ),
                  }
                : {})}
            />
          )}
        </TabsContent>
      </Tabs>

      {/* Create Component Dialog */}
      <Dialog open={createCompOpen} onOpenChange={setCreateCompOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Component</DialogTitle>
            <DialogDescription>Add a new service component to the status page.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="comp-slug">Slug</Label>
              <Input
                id="comp-slug"
                value={compSlug}
                onChange={(e) => setCompSlug(e.target.value)}
                placeholder="api-gateway"
                pattern="[a-z0-9-]+"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="comp-name">Display Name</Label>
              <Input
                id="comp-name"
                value={compName}
                onChange={(e) => setCompName(e.target.value)}
                placeholder="API Gateway"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="comp-group">Group (optional)</Label>
              <Input
                id="comp-group"
                value={compGroup}
                onChange={(e) => setCompGroup(e.target.value)}
                placeholder="Infrastructure"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateCompOpen(false)} disabled={compSaving}>
              Cancel
            </Button>
            <LoadingButton
              loading={compSaving}
              onClick={handleCreateComponent}
              disabled={compSlug.length === 0 || compName.length === 0}
            >
              Add Component
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Incident Dialog */}
      <Dialog open={createIncOpen} onOpenChange={setCreateIncOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish Incident</DialogTitle>
            <DialogDescription>Create and publish a new incident report.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="inc-title">Title</Label>
              <Input
                id="inc-title"
                value={incTitle}
                onChange={(e) => setIncTitle(e.target.value)}
                placeholder="Elevated error rates on API"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="inc-body">Description</Label>
              <Textarea
                id="inc-body"
                value={incBody}
                onChange={(e) => setIncBody(e.target.value)}
                placeholder="Describe the incident..."
                rows={3}
              />
            </div>
            <div className="grid gap-2">
              <Label>Severity</Label>
              <Select value={incSeverity} onValueChange={setIncSeverity}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INCIDENT_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateIncOpen(false)} disabled={incSaving}>
              Cancel
            </Button>
            <LoadingButton
              loading={incSaving}
              onClick={handleCreateIncident}
              disabled={incTitle.length === 0 || incBody.length === 0}
            >
              Publish
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
