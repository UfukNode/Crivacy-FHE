'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { ExternalLink, Plus, Search, Webhook } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { CopyButton } from '@/components/shared/copy-button';
import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';
import { MaskedValue } from '@/components/shared/masked-value';
import { RelativeTime } from '@/components/shared/relative-time';
import { StatusBadge } from '@/components/shared/status-badge';
import { useFirmPermissions } from '@/hooks/use-firm-permissions';
import {
  WEBHOOK_EVENT_METADATA,
  WEBHOOK_EVENT_VALUES,
  type WebhookEvent,
} from '@/lib/enums';

// Group events by their `foo.bar.baz` → `foo` / `foo.bar` prefix so
// the create form reads like a product surface instead of a flat
// dump. Keeps the dashboard's source of truth (the canonical enum)
// intact, this is purely a display adapter.
const EVENT_GROUPS: ReadonlyArray<{
  readonly label: string;
  readonly events: readonly WebhookEvent[];
}> = (() => {
  const byGroup = new Map<string, WebhookEvent[]>();
  for (const event of WEBHOOK_EVENT_VALUES) {
    const parts = event.split('.');
    const prefix = parts.length >= 3 ? `${parts[0]}.${parts[1]}` : (parts[0] ?? event);
    const key = prefix ?? event;
    const list = byGroup.get(key) ?? [];
    list.push(event);
    byGroup.set(key, list);
  }
  const labelFor = (key: string): string => {
    if (key === 'credential') return 'Credentials';
    if (key === 'kyc.session') return 'KYC Sessions';
    if (key === 'oauth.consent') return 'OAuth Consent';
    // Fallback, Title-case the prefix. Guards against a new event
    // family landing in the enum without a label mapping here.
    return key
      .split('.')
      .map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
      .join(' ');
  };
  return Array.from(byGroup.entries()).map(([key, events]) => ({
    label: labelFor(key),
    events,
  }));
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebhookEndpoint {
  id: string;
  url: string;
  events: readonly string[];
  // Field names mirror the shared `WebhookEndpointSummary` DTO so a
  // type change there surfaces here at compile time (the API
  // contract is the single source of truth, not this page).
  active: boolean;
  secretMasked: string;
  createdAt: string;
  lastDeliveryAt: string | null;
}

interface WebhookListResponse {
  readonly data: readonly WebhookEndpoint[];
  readonly pagination: { readonly nextCursor: string | null; readonly limit: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
//
// Event list derives from the canonical `WebhookEventType` Zod enum
// via `@/lib/enums`. The previous hardcoded array had drifted —
// `kyc.session.completed`, `kyc.session.expired`, `kyc.session.failed`
// and `kyc.credential.issued` existed on this checkbox list but were
// never emitted by the backend, so firms ticking them could save a
// webhook subscription for an event that would never fire. Binding
// to the enum + `satisfies Record<...>` metadata guarantees this can
// never happen again: any new event in the enum without a metadata
// entry fails TypeScript.

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function WebhooksSkeleton() {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-8 w-16" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Webhooks management page -- list, create, edit, delete webhook endpoints.
 */
export default function WebhooksPage() {
  // List endpoint returns a `{ data, pagination }` envelope. Unwrap
  // so every downstream `.map` / `.length` works on a flat array —
  // same pattern the api-keys + playground surfaces use.
  const {
    data: rawList,
    error,
    isLoading,
    mutate,
  } = useSWR<WebhookListResponse>('/api/internal/webhooks');
  const webhooks = rawList?.data;

  // Permission gates matching the server-side middleware. Hide
  // affordances the caller cannot execute; server still enforces.
  const { has: hasFirmPermission } = useFirmPermissions();
  const canCreate = hasFirmPermission('webhook.create');
  const canUpdate = hasFirmPermission('webhook.update');
  const canDelete = hasFirmPermission('webhook.delete');

  // Create / edit dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<WebhookEndpoint | null>(null);
  const [formUrl, setFormUrl] = useState('');
  const [formEvents, setFormEvents] = useState<Set<WebhookEvent>>(new Set());
  const [formEnabled, setFormEnabled] = useState(true);
  const [showSaveReauth, setShowSaveReauth] = useState(false);
  const [eventQuery, setEventQuery] = useState('');

  // Filter the grouped event list by the current search query. We
  // match against the event name + label + description + keyword
  // synonyms so typing "create", "new", or "onboard" all surface
  // `credential.created`. Case-insensitive, whitespace-tokenised —
  // every token must match SOMEWHERE in the haystack so `new user`
  // still finds `credential.created` even though those two words
  // live in different fields.
  const filteredGroups = useMemo(() => {
    const query = eventQuery.trim().toLowerCase();
    if (query.length === 0) return EVENT_GROUPS;
    const tokens = query.split(/\s+/);
    return EVENT_GROUPS.map((group) => {
      const events = group.events.filter((event) => {
        const meta = WEBHOOK_EVENT_METADATA[event];
        const haystack = [event, meta.label, meta.description, ...meta.keywords]
          .join(' ')
          .toLowerCase();
        return tokens.every((t) => haystack.includes(t));
      });
      return { ...group, events };
    }).filter((group) => group.events.length > 0);
  }, [eventQuery]);
  const filteredEventCount = filteredGroups.reduce(
    (sum, group) => sum + group.events.length,
    0,
  );

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<WebhookEndpoint | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteReauth, setShowDeleteReauth] = useState(false);

  function openCreate() {
    setEditTarget(null);
    setFormUrl('');
    // Opt-in by default (Stripe/Twilio/GitHub convention). Firms
    // explicitly pick the events they want to consume so they aren't
    // silently receiving payloads for features they don't use.
    setFormEvents(new Set());
    setFormEnabled(true);
    setEventQuery('');
    setDialogOpen(true);
  }

  function selectAllEvents() {
    // When a filter is active, "Select all" adds only the events
    // currently visible, matches the user's expectation when the
    // panel is narrowed. With no query, it adds every event.
    setFormEvents((prev) => {
      const next = new Set(prev);
      const target =
        eventQuery.trim().length > 0
          ? filteredGroups.flatMap((g) => g.events)
          : WEBHOOK_EVENT_VALUES;
      for (const event of target) next.add(event);
      return next;
    });
  }
  function clearAllEvents() {
    setFormEvents(new Set());
  }

  function openEdit(wh: WebhookEndpoint) {
    setEditTarget(wh);
    setFormUrl(wh.url);
    // Narrow the incoming event list to the canonical enum, any
    // legacy rows that still carry a drift value (e.g. historical
    // `kyc.session.completed` from before this page was fixed) are
    // silently dropped from the Set. The UI only ever holds valid
    // events; saving the edit persists only valid events, so the
    // next write cleans the row.
    const validEventSet = new Set<string>(WEBHOOK_EVENT_VALUES);
    const filteredEvents = wh.events.filter((e): e is WebhookEvent =>
      validEventSet.has(e),
    );
    setFormEvents(new Set(filteredEvents));
    setFormEnabled(wh.active);
    setEventQuery('');
    setDialogOpen(true);
  }

  function toggleEvent(event: WebhookEvent) {
    setFormEvents((prev) => {
      const next = new Set(prev);
      if (next.has(event)) {
        next.delete(event);
      } else {
        next.add(event);
      }
      return next;
    });
  }

  function handleSaveClick() {
    if (formUrl.trim().length === 0) {
      toast.error('Please enter a webhook URL.');
      return;
    }
    if (formEvents.size === 0) {
      toast.error('Please select at least one event.');
      return;
    }
    setShowSaveReauth(true);
  }

  // BUG #58 + BUG #57: webhook endpoint URL is a data-exfil channel
  // for every firm event. Both create AND edit are gated with
  // password + TOTP reauth (flipping the URL on an existing endpoint
  // is the same primitive as creating a fresh attacker-controlled
  // one). Throw on backend rejection so the modal renders the error.
  async function handleSaveConfirmed({
    currentPassword,
    totpCode,
  }: {
    currentPassword: string;
    totpCode: string;
  }) {
    const isEdit = editTarget !== null;
    const url = isEdit
      ? `/api/internal/webhooks/${editTarget.id}`
      : '/api/internal/webhooks';
    const method = isEdit ? 'PATCH' : 'POST';

    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      // Server contract uses `active`; the field name is shared
      // with the public `/api/v1/webhooks` API. Don't rename back
      // to `enabled` just because the UI var is called that.
      body: JSON.stringify({
        url: formUrl.trim(),
        events: [...formEvents],
        active: formEnabled,
        currentPassword,
        totpCode,
      }),
    });

    if (!res.ok) {
      const body = (await res.json()) as Record<string, unknown>;
      const err = body['error'] as Record<string, unknown> | undefined;
      throw new Error(
        (err?.['message'] as string) ??
          `Failed to ${isEdit ? 'update' : 'create'} webhook.`,
      );
    }

    toast.success(isEdit ? 'Webhook updated.' : 'Webhook created.');
    setDialogOpen(false);
    void mutate();
  }

  function handleDeleteClick() {
    if (deleteTarget === null) return;
    setShowDeleteReauth(true);
  }

  // Cat 38 destructive-reauth (Page 7 closure): delete now requires
  // password + TOTP. Modal `onConfirm` throws on backend rejection
  // so the dialog renders the error inline.
  async function handleDeleteConfirmed({
    currentPassword,
    totpCode,
  }: {
    currentPassword: string;
    totpCode: string;
  }) {
    if (deleteTarget === null) return;

    setDeleting(true);
    try {
      const res = await fetch(`/api/internal/webhooks/${deleteTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, totpCode }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = body['error'] as Record<string, unknown> | undefined;
        throw new Error(
          (err?.['message'] as string) ?? 'Failed to delete webhook.',
        );
      }

      toast.success('Webhook deleted.');
      setDeleteTarget(null);
      void mutate();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhooks"
        description="Receive real-time notifications for KYC events."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" asChild>
              <Link href="/docs/webhooks">Documentation</Link>
            </Button>
            {canCreate ? (
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" />
                Add Endpoint
              </Button>
            ) : null}
          </div>
        }
      />

      {/* Error state */}
      {error && !isLoading && (
        <Card className="border-[var(--color-danger)]/30">
          <CardContent className="pt-6">
            <p className="text-sm text-[var(--color-danger)]">
              Failed to load webhooks. Please try refreshing the page.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {isLoading && <WebhooksSkeleton />}

      {/* Empty state */}
      {!isLoading && !error && webhooks && webhooks.length === 0 && (
        <EmptyState
          icon={<Webhook className="h-6 w-6" />}
          title="No webhooks yet"
          description={
            canCreate
              ? 'Add a webhook endpoint to receive real-time KYC event notifications.'
              : 'No webhook endpoints configured. Ask an admin to add one.'
          }
          action={
            canCreate ? (
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" />
                Add Endpoint
              </Button>
            ) : undefined
          }
        />
      )}

      {/* Webhooks table */}
      {!isLoading && webhooks && webhooks.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-wider text-[var(--color-muted)]">
                    <th scope="col" className="pb-3 pr-4">URL</th>
                    <th scope="col" className="pb-3 pr-4">Events</th>
                    <th scope="col" className="pb-3 pr-4">Status</th>
                    <th scope="col" className="pb-3 pr-4">Secret</th>
                    <th scope="col" className="pb-3 pr-4">Created</th>
                    <th scope="col" className="pb-3 pr-4">Last Delivery</th>
                    <th scope="col" className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {webhooks.map((wh) => (
                    <tr
                      key={wh.id}
                      className="border-b border-[var(--color-border)]/50"
                    >
                      <td className="max-w-xs truncate py-3 pr-4 font-mono text-xs">
                        {wh.url}
                      </td>
                      <td className="py-3 pr-4">
                        <span className="text-xs text-[var(--color-muted)]">
                          {wh.events.length} event{wh.events.length !== 1 ? 's' : ''}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <StatusBadge status={wh.active ? 'success' : 'neutral'}>
                          {wh.active ? 'Enabled' : 'Disabled'}
                        </StatusBadge>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-1">
                          {/* Full secret is only ever surfaced once
                              at creation time; the list endpoint
                              returns a masked placeholder. Render it
                              as text (no copy affordance) so users
                              don't think they're copying a usable
                              secret. */}
                          <span className="font-mono text-xs text-[var(--color-muted)]">
                            {wh.secretMasked}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-[var(--color-muted)]">
                        <RelativeTime date={wh.createdAt} className="text-xs" />
                      </td>
                      <td className="py-3 pr-4 text-[var(--color-muted)]">
                        {wh.lastDeliveryAt !== null ? (
                          <RelativeTime date={wh.lastDeliveryAt} className="text-xs" />
                        ) : (
                          <span className="text-xs">Never</span>
                        )}
                      </td>
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          {canUpdate ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(wh)}
                            >
                              Edit
                            </Button>
                          ) : null}
                          {canDelete ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
                              onClick={() => setDeleteTarget(wh)}
                            >
                              Delete
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create / Edit dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDialogOpen(false);
            setEditTarget(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editTarget !== null ? 'Edit Webhook' : 'Add Webhook Endpoint'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-6">
            {/* Section 1, URL. A plain labelled input, nothing
             * visually competing with it so the eye locks on the
             * one field the firm MUST fill in. */}
            <section className="space-y-2">
              <Label htmlFor="webhook-url">Endpoint URL</Label>
              <Input
                id="webhook-url"
                type="url"
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="https://example.com/webhooks/crivacy"
              />
              <p className="text-xs text-[var(--color-muted)]">
                HTTPS only. Private, loopback, and cloud-metadata addresses are rejected.
              </p>
            </section>

            {/* Section 2, Events. Presented as a panel so the
             * heading + search + list + counters read as ONE
             * compound control rather than four stacked labels
             * fighting the URL section for attention. Matches
             * Stripe's webhook form. */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                  Events
                </h3>
                <span className="text-xs text-[var(--color-muted)]">
                  {formEvents.size} of {WEBHOOK_EVENT_VALUES.length} selected
                  {eventQuery.trim().length > 0 && filteredEventCount !== WEBHOOK_EVENT_VALUES.length && (
                    <span className="ml-1 text-[var(--color-muted)]/70">
                      · {filteredEventCount} shown
                    </span>
                  )}
                </span>
              </div>

              <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]/40">
                {/* Search row, sits INSIDE the panel, filled style
                 * with no outlined border, so it reads as a filter
                 * affordance for the list below, not a peer of the
                 * URL input above. */}
                <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]/30 px-3 py-2">
                  <Search
                    className="h-4 w-4 shrink-0 text-[var(--color-muted)]"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={eventQuery}
                    onChange={(e) => setEventQuery(e.target.value)}
                    placeholder="Search events, try ‘new’, ‘blockchain’, ‘disconnect’…"
                    className="docs-search-field flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--color-fg)] placeholder:text-[var(--color-muted)] focus:outline-none focus:ring-0"
                    aria-label="Search events"
                  />
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[11px]"
                      onClick={selectAllEvents}
                      disabled={filteredEventCount === 0}
                    >
                      Select {eventQuery.trim().length > 0 ? 'visible' : 'all'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[11px]"
                      onClick={clearAllEvents}
                      disabled={formEvents.size === 0}
                    >
                      Clear
                    </Button>
                  </div>
                </div>

                <div className="max-h-[38vh] overflow-y-auto">
                  {filteredEventCount === 0 ? (
                    <div className="px-4 py-10 text-center text-sm text-[var(--color-muted)]">
                      <p>No events match “{eventQuery}”.</p>
                      <p className="mt-1 text-xs">
                        Try a different keyword or{' '}
                        <button
                          type="button"
                          onClick={() => setEventQuery('')}
                          className="underline hover:text-[var(--color-fg)]"
                        >
                          clear the search
                        </button>
                        .
                      </p>
                    </div>
                  ) : null}
                  {filteredGroups.map((group, groupIndex) => (
                  <div
                    key={group.label}
                    className={
                      groupIndex > 0
                        ? 'border-t border-[var(--color-border)]'
                        : ''
                    }
                  >
                    <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                      {group.label}
                    </div>
                    <ul className="p-1.5">
                      {group.events.map((event) => {
                        const meta = WEBHOOK_EVENT_METADATA[event];
                        const isSelected = formEvents.has(event);
                        const inputId = `event-${event}`;
                        return (
                          <li key={event}>
                            <label
                              htmlFor={inputId}
                              data-selected={isSelected}
                              className="group flex cursor-pointer items-start gap-3 rounded-[var(--radius-sm)] border border-transparent px-3 py-2.5 transition-colors data-[selected=true]:border-[var(--color-accent)]/30 data-[selected=true]:bg-[var(--color-accent)]/8 hover:bg-[var(--color-surface-hover)]"
                            >
                              <Checkbox
                                id={inputId}
                                checked={isSelected}
                                onCheckedChange={() => toggleEvent(event)}
                                // `border-border` blends into the row's hover
                                // surface on some themes; lifting the contrast
                                // inside the `group-hover` state keeps the
                                // control visible no matter what the user is
                                // pointing at.
                                className="mt-0.5 h-[18px] w-[18px] border-[var(--color-muted)]/40 group-hover:border-[var(--color-muted)] data-[state=checked]:border-[var(--color-accent)]"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="font-mono text-[13px] leading-5 text-[var(--color-fg)]">
                                  {event}
                                </div>
                                <div className="mt-1 text-[12px] leading-[1.45] text-[var(--color-muted)]">
                                  {meta.description}
                                </div>
                              </div>
                              {/* Direct link to the docs anchor for this
                                  event. The row as a whole is a `<label>`
                                  that toggles the checkbox on click —
                                  Radix Popover nested inside the label
                                  had a swallowed-click bug because the
                                  label always steals focus. A plain
                                  `<a>` with e.stopPropagation sidesteps
                                  the issue entirely and lands the dev
                                  directly on the trigger + payload
                                  documentation section. */}
                              <Link
                                href={`/docs/webhooks#event-${event.replace(/\./g, '-')}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                aria-label={`Open documentation for ${event}`}
                                title="View in documentation"
                                className="shrink-0 self-start rounded-full p-1 text-[var(--color-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-fg)]"
                              >
                                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                              </Link>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                </div>
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                Delivery
              </h3>
              <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]/40 px-4 py-3">
                <div>
                  <Label htmlFor="webhook-enabled" className="text-sm">Enabled</Label>
                  <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                    Disable to stop deliveries without losing the endpoint config.
                  </p>
                </div>
                <Switch
                  id="webhook-enabled"
                  checked={formEnabled}
                  onCheckedChange={setFormEnabled}
                />
              </div>
            </section>
          </div>
          <DialogFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Link
              href="/docs/webhooks#events"
              className="order-2 text-xs text-[var(--color-muted)] underline-offset-2 hover:text-[var(--color-fg)] hover:underline sm:order-1"
            >
              View payload samples and triggers in the documentation
            </Link>
            <div className="order-1 flex items-center justify-end gap-2 sm:order-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSaveClick}>
                {editTarget !== null ? 'Save Changes' : 'Create Webhook'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DestructiveReauthModal
        open={showSaveReauth}
        onOpenChange={setShowSaveReauth}
        audience="firm"
        title={editTarget !== null ? 'Update webhook endpoint' : 'Create webhook endpoint'}
        description="Webhook URL changes route every firm event to wherever you point them. Confirm your identity to proceed."
        confirmLabel={editTarget !== null ? 'Save changes' : 'Create webhook'}
        onConfirm={handleSaveConfirmed}
      />

      {/* Delete confirmation dialog (step 1, confirm intent) */}
      <ConfirmDialog
        open={deleteTarget !== null && !showDeleteReauth}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete Webhook"
        description={`Are you sure you want to delete the webhook for "${deleteTarget?.url ?? ''}"? You will no longer receive events at this endpoint.`}
        confirmLabel="Delete"
        variant="destructive"
        loading={deleting}
        onConfirm={handleDeleteClick}
      />

      {/* Delete reauth dialog (step 2, password + TOTP) */}
      <DestructiveReauthModal
        open={showDeleteReauth}
        onOpenChange={(open) => {
          setShowDeleteReauth(open);
          if (!open) setDeleteTarget(null);
        }}
        audience="firm"
        destructive
        title="Delete webhook endpoint"
        description={`Deleting "${deleteTarget?.url ?? ''}" stops every event delivery to this URL. Confirm with your password and authenticator code.`}
        confirmLabel="Delete webhook"
        onConfirm={handleDeleteConfirmed}
      />
    </div>
  );
}
