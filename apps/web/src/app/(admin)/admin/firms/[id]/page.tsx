'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle2, KeyRound, Lock, ShieldCheck, Ticket, Unlock, Webhook } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { RelativeTime } from '@/components/shared/relative-time';
import { UserAvatar } from '@/components/shared/user-avatar';
import {
  useAdminFirmAction,
  useAdminFirmDetail,
  type AdminFirmDetailApiKey,
  type AdminFirmDetailUser,
  type AdminFirmDetailWebhookEndpoint,
} from '@/hooks/use-admin-firm-detail';
import { useAdminPermissions } from '@/hooks/use-admin-permissions';
import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';
import { FIRM_ROLES } from '@/lib/firm/roles';

function roleLabel(id: string): string {
  return FIRM_ROLES.find((r) => r.id === id)?.label ?? id;
}

/* -------------------------------------------------------------------------- */
/*  Tab panes                                                                 */
/* -------------------------------------------------------------------------- */

interface OverviewPaneProps {
  readonly firm: NonNullable<ReturnType<typeof useAdminFirmDetail>['detail']>['firm'];
  readonly tickets: Readonly<Record<string, number>>;
  readonly usersCount: number;
  readonly apiKeyCount: number;
  readonly webhookCount: number;
}

function OverviewPane({ firm, tickets, usersCount, apiKeyCount, webhookCount }: OverviewPaneProps) {
  const items: { label: string; value: string | number | null }[] = [
    { label: 'Slug', value: firm.slug },
    { label: 'Tier', value: firm.tier },
    { label: 'Country', value: firm.countryCode ?? '—' },
    { label: 'Contact', value: firm.contactEmail ?? '—' },
    { label: 'Billing', value: firm.billingEmail ?? '—' },
    { label: 'Support URL', value: firm.supportUrl ?? '—' },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader className="pb-3"><CardTitle className="text-sm">Firm details</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            {items.map((item) => (
              <div key={item.label}>
                <dt className="text-xs text-[var(--color-muted)]">{item.label}</dt>
                <dd className="text-sm text-[var(--color-fg)]">{item.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">Stats</CardTitle></CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-[var(--color-muted)]">Team members</dt>
              <dd className="font-medium text-[var(--color-fg)]">{usersCount}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-[var(--color-muted)]">API keys</dt>
              <dd className="font-medium text-[var(--color-fg)]">{apiKeyCount}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-[var(--color-muted)]">Webhook endpoints</dt>
              <dd className="font-medium text-[var(--color-fg)]">{webhookCount}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-[var(--color-muted)]">Tickets (open)</dt>
              <dd className="font-medium text-[var(--color-fg)]">
                {(tickets['open'] ?? 0) + (tickets['in_progress'] ?? 0) + (tickets['waiting_customer'] ?? 0)}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-[var(--color-muted)]">Tickets (total)</dt>
              <dd className="font-medium text-[var(--color-fg)]">{tickets['total'] ?? 0}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

interface UsersPaneProps {
  readonly firmId: string;
  readonly users: readonly AdminFirmDetailUser[];
  readonly canUnlock: boolean;
  readonly onChanged: () => void | Promise<void>;
}

function UsersPane({ firmId, users, canUnlock, onChanged }: UsersPaneProps) {
  const { execute } = useAdminFirmAction();
  // BUG #58: unlock now requires password+TOTP reauth. We capture
  // the target user up-front so the modal can show *who* is being
  // unlocked, and throw on backend rejection so the modal renders
  // the failure inline.
  const [pendingUnlock, setPendingUnlock] = React.useState<AdminFirmDetailUser | null>(null);

  async function handleUnlockConfirmed({
    currentPassword,
    totpCode,
  }: { currentPassword: string; totpCode: string }): Promise<void> {
    if (pendingUnlock === null) return;
    const res = await execute(
      `/api/internal/admin/firms/${firmId}/users/${pendingUnlock.id}/unlock`,
      { method: 'POST', body: { currentPassword, totpCode } },
    );
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = payload['error'] as Record<string, unknown> | undefined;
      throw new Error((err?.['message'] as string | undefined) ?? 'Unlock failed.');
    }
    toast.success('Unlocked.');
    setPendingUnlock(null);
    await onChanged();
  }

  if (users.length === 0) {
    return <p className="text-sm text-[var(--color-muted)]">No team members yet.</p>;
  }

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-sm">Team members ({users.length})</CardTitle></CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {users.map((u) => {
            const status: 'invited' | 'active' | 'locked' =
              u.lockedAt !== null ? 'locked' : u.acceptedAt !== null ? 'active' : 'invited';
            const badge =
              status === 'locked'
                ? { label: 'Locked', variant: 'destructive' as const }
                : status === 'invited'
                  ? { label: 'Invite pending', variant: 'warning' as const }
                  : null;
            return (
              <li
                key={u.id}
                className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5"
              >
                <UserAvatar user={{ id: u.id, displayName: u.email }} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="truncate text-sm font-medium text-[var(--color-fg)]">{u.email}</p>
                    <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                      {roleLabel(u.role)}
                    </Badge>
                    {badge !== null && (
                      <Badge variant={badge.variant} className="shrink-0 px-1.5 py-0 text-[10px]">
                        {badge.label}
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-[var(--color-muted)]">
                    {u.lastLoginAt !== null ? (
                      <>Last seen <RelativeTime date={u.lastLoginAt} /></>
                    ) : (
                      'No sign-in yet'
                    )}
                  </p>
                </div>
                {status === 'locked' && canUnlock && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setPendingUnlock(u); }}
                    className="shrink-0"
                  >
                    <Unlock className="h-3.5 w-3.5" aria-hidden="true" />
                    Unlock
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
      <DestructiveReauthModal
        open={pendingUnlock !== null}
        onOpenChange={(open) => { if (!open) setPendingUnlock(null); }}
        audience="admin"
        title="Unlock firm user"
        description={`Re-authenticate to clear the failed-login lock on ${pendingUnlock?.email ?? ''}.`}
        confirmLabel="Unlock account"
        onConfirm={handleUnlockConfirmed}
      />
    </Card>
  );
}

interface ApiKeysPaneProps {
  readonly keys: readonly AdminFirmDetailApiKey[];
}

function ApiKeysPane({ keys }: ApiKeysPaneProps) {
  if (keys.length === 0) {
    return <p className="text-sm text-[var(--color-muted)]">No API keys created yet.</p>;
  }
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">API keys ({keys.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-[var(--color-muted)]">
          Metadata only, secrets are hashed and never returned.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)]">
              <tr>
                {['Name', 'Prefix', 'Mode', 'Scopes', 'Last used', 'Status', 'Created'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-medium text-[var(--color-muted)]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {keys.map((k) => (
                <tr key={k.id}>
                  <td className="whitespace-nowrap px-3 py-2">{k.name}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-[var(--color-accent)]">
                    {k.prefix}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                      {k.mode}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--color-muted)]">
                    {k.scopes.length === 0 ? '—' : k.scopes.join(', ')}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-[var(--color-muted)]">
                    {k.lastUsedAt !== null ? <RelativeTime date={k.lastUsedAt} /> : 'Never'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {k.revokedAt !== null ? (
                      <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">Revoked</Badge>
                    ) : k.expiresAt !== null && new Date(k.expiresAt) < new Date() ? (
                      <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">Expired</Badge>
                    ) : (
                      <Badge variant="success" className="px-1.5 py-0 text-[10px]">Active</Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-[var(--color-muted)]">
                    <RelativeTime date={k.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

interface ActivityPaneProps {
  readonly webhooks: {
    readonly endpoints: readonly AdminFirmDetailWebhookEndpoint[];
    readonly health: { readonly deliveries24h: number; readonly failures24h: number; readonly successRate: number | null };
  };
}

function ActivityPane({ webhooks }: ActivityPaneProps) {
  const rate = webhooks.health.successRate;
  const healthBadge =
    rate === null
      ? { label: 'No traffic', variant: 'secondary' as const }
      : rate >= 0.95
        ? { label: 'Healthy', variant: 'success' as const }
        : { label: 'Degraded', variant: 'warning' as const };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Webhook health (last 24h)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <Badge variant={healthBadge.variant}>{healthBadge.label}</Badge>
            <span className="text-[var(--color-muted)]">
              Deliveries: <span className="font-medium text-[var(--color-fg)]">{webhooks.health.deliveries24h}</span>
            </span>
            <span className="text-[var(--color-muted)]">
              Failures: <span className="font-medium text-[var(--color-fg)]">{webhooks.health.failures24h}</span>
            </span>
            <span className="text-[var(--color-muted)]">
              Success rate:{' '}
              <span className="font-medium text-[var(--color-fg)]">
                {rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}
              </span>
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Endpoints ({webhooks.endpoints.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {webhooks.endpoints.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">No webhook endpoints configured.</p>
          ) : (
            <ul className="space-y-2">
              {webhooks.endpoints.map((w) => (
                <li
                  key={w.id}
                  className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5"
                >
                  <Webhook className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)]" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-[var(--color-fg)]">{w.label}</span>
                      {w.isActive ? (
                        <Badge variant="success" className="px-1.5 py-0 text-[10px]">Active</Badge>
                      ) : (
                        <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">Disabled</Badge>
                      )}
                    </p>
                    <p className="truncate text-xs text-[var(--color-muted)]">{w.url}</p>
                    <p className="text-xs text-[var(--color-muted)]">
                      Subscribed: {w.events.length === 0 ? '—' : w.events.join(', ')}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface TicketsPaneProps {
  readonly firmId: string;
  readonly counts: Readonly<Record<string, number>>;
}

function TicketsPane({ firmId, counts }: TicketsPaneProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Tickets</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          {['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'].map((status) => (
            <div key={status} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
              <dt className="text-xs text-[var(--color-muted)]">{status.replace(/_/g, ' ')}</dt>
              <dd className="text-lg font-semibold text-[var(--color-fg)]">{counts[status] ?? 0}</dd>
            </div>
          ))}
        </dl>
        <Button asChild variant="outline" size="sm">
          <Link href={`/admin/tickets?firmId=${firmId}`}>
            <Ticket className="h-3.5 w-3.5" aria-hidden="true" />
            Open in tickets view
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

export default function AdminFirmDetailPage() {
  const params = useParams();
  const rawId = params?.['id'];
  const firmId = typeof rawId === 'string' ? rawId : null;
  const { detail, isLoading, error, mutate } = useAdminFirmDetail(firmId);
  const { has: hasAdminPermission } = useAdminPermissions();
  const canUnlock = hasAdminPermission('admin.firm.firm_user.unlock');

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error !== undefined || detail === null) {
    const status = (error as { status?: number } | undefined)?.status;
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/admin/firms">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to Firms
          </Link>
        </Button>
        <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-4 text-sm text-[var(--color-danger)]">
          {status === 404 ? 'Firm not found.' : 'Failed to load firm.'}
        </div>
      </div>
    );
  }

  const { firm, users, apiKeys, webhooks, tickets } = detail;

  return (
    <div className="space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/admin/firms">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to Firms
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold text-[var(--color-fg)]">{firm.name}</h1>
          <Badge variant="secondary" className="px-2 py-0.5 text-[11px] uppercase tracking-wide">
            {firm.tier}
          </Badge>
          {firm.deletedAt !== null && (
            <Badge variant="destructive" className="px-2 py-0.5 text-[11px]">Deleted</Badge>
          )}
        </div>
        <p className="mt-1 font-mono text-xs text-[var(--color-muted)]">{firm.slug}</p>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview"><ShieldCheck className="mr-1 h-3.5 w-3.5" />Overview</TabsTrigger>
          <TabsTrigger value="users"><CheckCircle2 className="mr-1 h-3.5 w-3.5" />Users ({users.length})</TabsTrigger>
          <TabsTrigger value="api-keys"><KeyRound className="mr-1 h-3.5 w-3.5" />API Keys ({apiKeys.length})</TabsTrigger>
          <TabsTrigger value="activity"><Webhook className="mr-1 h-3.5 w-3.5" />Activity</TabsTrigger>
          <TabsTrigger value="tickets"><Ticket className="mr-1 h-3.5 w-3.5" />Tickets ({tickets['total'] ?? 0})</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <OverviewPane
            firm={firm}
            tickets={tickets}
            usersCount={users.length}
            apiKeyCount={apiKeys.length}
            webhookCount={webhooks.endpoints.length}
          />
        </TabsContent>
        <TabsContent value="users" className="mt-4">
          <UsersPane
            firmId={firm.id}
            users={users}
            canUnlock={canUnlock}
            onChanged={async () => {
              await mutate();
            }}
          />
        </TabsContent>
        <TabsContent value="api-keys" className="mt-4">
          <ApiKeysPane keys={apiKeys} />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <ActivityPane webhooks={webhooks} />
        </TabsContent>
        <TabsContent value="tickets" className="mt-4">
          <TicketsPane firmId={firm.id} counts={tickets} />
        </TabsContent>
      </Tabs>
      {/* Silence Lock unused-import warning, reserved for a future
          "revoke firm" / "disable firm login" action. */}
      <span className="hidden"><Lock /></span>
    </div>
  );
}
