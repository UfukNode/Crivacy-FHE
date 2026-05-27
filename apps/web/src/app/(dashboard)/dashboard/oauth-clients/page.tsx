'use client';

/**
 * Firm dashboard → OAuth Clients.
 *
 * List + create + revoke for the firm's registered OAuth/OIDC
 * clients. Rotate-secret lives inline on each row (dangerous +
 * rare, no separate page). The raw client_secret is shown exactly
 * once in the create-success dialog and the rotate-success dialog,
 * the list never renders it (DB only keeps a hash).
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Code, ExternalLink, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { PageHeader } from '@/components/shared/page-header';
import { CopyButton } from '@/components/shared/copy-button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';
import { EmptyState } from '@/components/shared/empty-state';
import { useFirmPermissions } from '@/hooks/use-firm-permissions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  OAUTH_SCOPE_METADATA,
  OAUTH_SCOPE_VALUES,
  levelHint,
  type OauthScopeId,
} from '@/lib/enums';

import {
  IntegrationQuickStartDrawer,
  type IntegrationQuickStartClient,
} from './integration-quickstart-drawer';

interface OauthClientSummary {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly description: string | null;
  readonly redirectUris: readonly string[];
  readonly allowedScopes: readonly string[];
  readonly isPublicClient: boolean;
  readonly secretMasked: string;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

function toIntegrationClient(client: OauthClientSummary): IntegrationQuickStartClient {
  return {
    clientId: client.clientId,
    name: client.name,
    redirectUris: client.redirectUris,
    allowedScopes: client.allowedScopes,
    isPublicClient: client.isPublicClient,
  };
}

interface ListResponse {
  readonly data: readonly OauthClientSummary[];
}

export default function OauthClientsPage() {
  const { data, error, isLoading, mutate } = useSWR<ListResponse>('/api/internal/oauth-clients');

  // Per-action permission gates (Admin+ has all four on the OAuth
  // surface per matrix; Member/Viewer see read-only). Update is
  // triggered from the dialog below when a user opens an existing
  // client's form; the dialog itself branches on `canUpdate` to
  // enable/disable the Save button.
  const { has: hasFirmPermission } = useFirmPermissions();
  const canCreate = hasFirmPermission('oauth_client.create');
  const canRotate = hasFirmPermission('oauth_client.rotate_secret');
  const canRevoke = hasFirmPermission('oauth_client.revoke');

  const [createOpen, setCreateOpen] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<{ clientId: string; secret: string } | null>(null);
  const [rotateTarget, setRotateTarget] = useState<OauthClientSummary | null>(null);
  const [rotateTargetReauth, setRotateTargetReauth] = useState<OauthClientSummary | null>(null);
  const [rotateResult, setRotateResult] = useState<{ clientId: string; secret: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<OauthClientSummary | null>(null);
  const [revokeTargetReauth, setRevokeTargetReauth] = useState<OauthClientSummary | null>(null);
  const [integrationTarget, setIntegrationTarget] = useState<IntegrationQuickStartClient | null>(
    null,
  );
  const [showCreateReauth, setShowCreateReauth] = useState(false);

  // Create form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formRedirectUris, setFormRedirectUris] = useState('');
  const [formScopes, setFormScopes] = useState<Set<OauthScopeId>>(
    new Set(['openid', 'kyc']),
  );
  const [formMode, setFormMode] = useState<'live' | 'test'>('test');
  const [formIsPublic, setFormIsPublic] = useState(false);

  const openCreate = useCallback(() => {
    setFormName('');
    setFormDescription('');
    setFormRedirectUris('');
    setFormScopes(new Set(['openid', 'kyc']));
    setFormMode('test');
    setFormIsPublic(false);
    setCreateOpen(true);
  }, []);

  function handleCreateClick(): void {
    const redirectUris = formRedirectUris
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (redirectUris.length === 0) {
      toast.error('At least one redirect URI is required.');
      return;
    }
    if (formScopes.size === 0) {
      toast.error('At least one scope is required.');
      return;
    }
    setShowCreateReauth(true);
  }

  // BUG #58: password + TOTP reauth before mint. Throws on backend
  // rejection so the modal renders the error inline.
  async function handleCreateConfirmed({
    currentPassword,
    totpCode,
  }: {
    currentPassword: string;
    totpCode: string;
  }): Promise<void> {
    const redirectUris = formRedirectUris
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const res = await fetch('/api/internal/oauth-clients', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: formName,
        description: formDescription.length > 0 ? formDescription : undefined,
        redirectUris,
        allowedScopes: [...formScopes],
        isPublicClient: formIsPublic,
        mode: formMode,
        consentTtlDays: 90,
        currentPassword,
        totpCode,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; details?: { issues?: Array<{ message?: string }> } };
      };
      const msg =
        body.error?.details?.issues?.[0]?.message ??
        body.error?.message ??
        'Failed to create OAuth client.';
      throw new Error(msg);
    }
    const result = (await res.json()) as {
      summary: OauthClientSummary;
      clientSecret: string | null;
    };
    setCreateOpen(false);
    if (result.clientSecret !== null) {
      setCreatedSecret({ clientId: result.summary.clientId, secret: result.clientSecret });
    } else {
      toast.success('Public OAuth client created (no secret).');
    }
    void mutate();
  }

  function handleRotateClick(target: OauthClientSummary): void {
    setRotateTargetReauth(target);
  }

  async function handleRotateConfirmed({
    currentPassword,
    totpCode,
  }: {
    currentPassword: string;
    totpCode: string;
  }): Promise<void> {
    if (rotateTargetReauth === null) {
      throw new Error('No client selected for rotation.');
    }
    const res = await fetch(
      `/api/internal/oauth-clients/${rotateTargetReauth.id}/rotate-secret`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, totpCode }),
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      throw new Error(body.error?.message ?? 'Failed to rotate secret.');
    }
    const body = (await res.json()) as {
      clientSecret: string;
      summary: OauthClientSummary;
    };
    setRotateResult({ clientId: body.summary.clientId, secret: body.clientSecret });
    setRotateTargetReauth(null);
    setRotateTarget(null);
    void mutate();
  }

  function handleRevokeClick(): void {
    if (revokeTarget === null) return;
    setRevokeTargetReauth(revokeTarget);
    setRevokeTarget(null);
  }

  // Cat 38 destructive-reauth (Page 7 closure): revoke now requires
  // password + TOTP. Soft-revoke cascades to access tokens + consents.
  async function handleRevokeConfirmed({
    currentPassword,
    totpCode,
  }: {
    currentPassword: string;
    totpCode: string;
  }): Promise<void> {
    if (revokeTargetReauth === null) return;
    const res = await fetch(`/api/internal/oauth-clients/${revokeTargetReauth.id}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, totpCode }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = body['error'] as Record<string, unknown> | undefined;
      throw new Error((err?.['message'] as string) ?? 'Failed to revoke OAuth client.');
    }
    toast.success('OAuth client revoked.');
    setRevokeTargetReauth(null);
    void mutate();
  }

  const clients = data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="OAuth Clients"
        description="Register apps that verify users with Crivacy. Each client has its own credentials, redirect URIs, and scope ceiling."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" asChild>
              <Link href="/docs/oauth">Documentation</Link>
            </Button>
            {canCreate ? (
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" />
                New client
              </Button>
            ) : null}
          </div>
        }
      />

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-[var(--color-danger)]">
            Failed to load OAuth clients. Please refresh the page.
          </CardContent>
        </Card>
      )}

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {!isLoading && clients.length === 0 && (
        <EmptyState
          title="No OAuth clients yet"
          description={
            canCreate
              ? 'Create a client to let your product initiate the Crivacy consent flow.'
              : 'No OAuth clients configured. Ask an admin to register one.'
          }
          action={
            canCreate ? (
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" />
                New client
              </Button>
            ) : undefined
          }
        />
      )}

      {!isLoading && clients.length > 0 && (
        <div className="space-y-3">
          {clients.map((client) => {
            const mode: 'live' | 'test' = client.clientId.startsWith('crv_oauth_live_')
              ? 'live'
              : 'test';
            const hasOtherKycScope = client.allowedScopes.some(
              (s) => s === 'kyc' || (s.startsWith('kyc:') && s !== 'credential'),
            );
            const showDescription =
              client.description !== null &&
              client.description.trim().length > 0 &&
              client.description.trim() !== client.name.trim();
            return (
              <Card
                key={client.id}
                className={client.revokedAt !== null ? 'opacity-60' : undefined}
              >
                <CardContent className="p-5">
                  {/* Header row, identity + status badges on the left,
                   * actions on the right. Destructive action is
                   * separated from safe ones with a divider so the
                   * Revoke click target isn't a one-tab-away accident. */}
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-base font-semibold text-[var(--color-fg)]">
                          {client.name}
                        </h3>
                        <Badge
                          variant={mode === 'live' ? 'success' : 'warning'}
                          className="uppercase tracking-[0.06em]"
                        >
                          {mode}
                        </Badge>
                        {/* Confidential / public is a neutral
                         * descriptor, not a status, use an outlined
                         * pill instead of a filled colour so it
                         * doesn't compete with the live/revoked
                         * badge. Subtle hover highlight keeps the
                         * "this is a badge, not a label" affordance
                         * the user flagged as missing. */}
                        <Badge
                          variant="outline"
                          className="font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                        >
                          {client.isPublicClient ? 'public' : 'confidential'}
                        </Badge>
                        {client.revokedAt !== null && (
                          <Badge variant="destructive">revoked</Badge>
                        )}
                      </div>
                      {showDescription && (
                        <p className="mt-1 text-xs text-[var(--color-muted)]">
                          {client.description}
                        </p>
                      )}
                    </div>
                    {client.revokedAt === null && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setIntegrationTarget(toIntegrationClient(client))}
                        >
                          <Code className="h-3.5 w-3.5" />
                          View code
                        </Button>
                        {!client.isPublicClient && canRotate ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRotateClick(client)}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                            Rotate secret
                          </Button>
                        ) : null}
                        {canRevoke ? (
                          <>
                            <span
                              aria-hidden="true"
                              className="mx-1 hidden h-5 w-px bg-[var(--color-border)] sm:inline-block"
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              className="border-[var(--color-danger)]/30 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
                              onClick={() => setRevokeTarget(client)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Revoke
                            </Button>
                          </>
                        ) : null}
                      </div>
                    )}
                  </div>

                  {/* Credentials section, client_id and client_secret
                   * get identical row treatment (label above, monospace
                   * value + copy affordance below) so no one has to
                   * wonder "why can I copy one and not the other". */}
                  <section className="mt-5 grid gap-4 sm:grid-cols-2">
                    <InlineCredentialRow
                      label="client_id"
                      value={client.clientId}
                      copyable
                    />
                    <InlineCredentialRow
                      label="client_secret"
                      value={client.secretMasked}
                      copyable={false}
                      hint={
                        client.isPublicClient
                          ? 'Public client, no secret issued.'
                          : 'Full secret only shown at creation. Rotate to generate a new one.'
                      }
                    />
                  </section>

                  {/* Redirect URIs */}
                  <section className="mt-5">
                    <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                      Redirect URIs
                    </h4>
                    <ul className="space-y-1">
                      {client.redirectUris.map((uri) => (
                        <li
                          key={uri}
                          className="group flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)]/40 px-3 py-2"
                        >
                          <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-fg)]">
                            {uri}
                          </code>
                          <CopyButton
                            value={uri}
                            iconOnly
                            size="sm"
                            aria-label={`Copy ${uri}`}
                          />
                        </li>
                      ))}
                    </ul>
                  </section>

                  {/* Scopes, `credential` keeps the "auto" affordance
                   * from the create form so the firm never wonders
                   * "why did I get the credential scope without selecting it".
                   * Other scopes render as muted outline pills. */}
                  <section className="mt-5">
                    <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                      Allowed Scopes
                    </h4>
                    <div className="flex flex-wrap gap-1.5">
                      {client.allowedScopes.map((scope) => {
                        const isCredentialAuto = scope === 'credential' && hasOtherKycScope;
                        return (
                          <span
                            key={scope}
                            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/40 px-2.5 py-1 font-mono text-[11px] text-[var(--color-fg)]"
                          >
                            {scope}
                            {isCredentialAuto && (
                              <span className="rounded-full bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.06em] text-[var(--color-accent)]">
                                Auto
                              </span>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </section>

                  {/* Metadata footer, lightweight, lowercase */}
                  <div className="mt-5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--color-muted)]">
                    <span>
                      Created{' '}
                      {new Date(client.createdAt).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </span>
                    {client.revokedAt !== null && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          Revoked{' '}
                          {new Date(client.revokedAt).toLocaleDateString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </span>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {/* Create dialog, same section / panel / footer pattern as
       * the webhooks dialog so firms learn one UX once. */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Create OAuth client</DialogTitle>
            <DialogDescription>
              Credentials are generated here. The secret is shown exactly once.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            {/* Section 1, Basics */}
            <section className="space-y-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                Basics
              </h3>
              <div className="space-y-2">
                <Label htmlFor="oauth-name">Name</Label>
                <Input
                  id="oauth-name"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="My app (staging)"
                />
                <p className="text-xs text-[var(--color-muted)]">
                  Internal label only. Not shown to end users.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="oauth-desc">Description</Label>
                <Input
                  id="oauth-desc"
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="Crivacy verifies identity for MyApp's signup flow."
                />
                <p className="text-xs text-[var(--color-muted)]">
                  Appears on the Crivacy consent screen so the user knows what they&apos;re
                  approving.
                </p>
              </div>
            </section>

            {/* Section 2, Redirect URIs */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                  Redirect URIs
                </h3>
              </div>
              <textarea
                id="oauth-redirects"
                value={formRedirectUris}
                onChange={(e) => setFormRedirectUris(e.target.value)}
                placeholder="https://myapp.com/oauth/callback"
                rows={3}
                className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-transparent px-3 py-2 font-mono text-xs text-[var(--color-fg)] shadow-[var(--shadow-sm)] placeholder:text-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]"
              />
              <p className="text-xs text-[var(--color-muted)]">
                One URL per line. HTTPS only. Exact match, query strings and fragments
                count. Loopback (<code className="font-mono">http://localhost</code>) is
                allowed for dev.
              </p>
            </section>

            {/* Section 3, Scopes */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                  Allowed Scopes
                </h3>
                <span className="text-xs text-[var(--color-muted)]">
                  {formScopes.size} of {OAUTH_SCOPE_VALUES.length} selected
                </span>
              </div>
              <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]/40">
                <ul className="p-1.5">
                  {OAUTH_SCOPE_VALUES.map((id) => {
                    const meta = OAUTH_SCOPE_METADATA[id];
                    const hint = levelHint(meta.requiredLevel);
                    // `credential` is a companion scope: any `kyc*`
                    // scope implicitly includes the credential reference so
                    // firms can independently verify the credential
                    // on-chain. That's Crivacy's whole differentiator
                    // against Web2 KYC, making it optional would let
                    // a firm silently opt into "trust Crivacy's word"
                    // mode, which defeats the product. We force-check
                    // and lock the row whenever another kyc scope is
                    // in the form set.
                    const hasOtherKyc = [...formScopes].some(
                      (s) => s === 'kyc' || (s.startsWith('kyc:') && s !== 'credential'),
                    );
                    const isCredentialAutoBundled = id === 'credential' && hasOtherKyc;
                    const isSelected = formScopes.has(id) || isCredentialAutoBundled;
                    const inputId = `scope-${id}`;
                    return (
                      <li key={id}>
                        <label
                          htmlFor={inputId}
                          data-selected={isSelected}
                          data-locked={isCredentialAutoBundled}
                          className="group flex items-start gap-3 rounded-[var(--radius-sm)] border border-transparent px-3 py-2.5 transition-colors data-[selected=true]:border-[var(--color-accent)]/30 data-[selected=true]:bg-[var(--color-accent)]/8 data-[locked=true]:cursor-not-allowed data-[locked=false]:cursor-pointer hover:data-[locked=false]:bg-[var(--color-surface-hover)]"
                        >
                          <Checkbox
                            id={inputId}
                            checked={isSelected}
                            disabled={isCredentialAutoBundled}
                            onCheckedChange={(checked) => {
                              setFormScopes((prev) => {
                                const next = new Set(prev);
                                if (checked === true) {
                                  next.add(id);
                                  // Selecting any kyc* scope also pulls
                                  // credential so submission + display
                                  // stay in sync with the server-side
                                  // `expandImplicitScopes` rule.
                                  if (id === 'kyc' || id.startsWith('kyc:')) {
                                    next.add('credential');
                                  }
                                } else {
                                  next.delete(id);
                                  // Deselecting the LAST kyc* scope
                                  // releases credential too, keeps
                                  // the form honest with what the
                                  // client will actually be allowed.
                                  const stillHasKyc = [...next].some(
                                    (s) => s === 'kyc' || (s.startsWith('kyc:') && s !== 'credential'),
                                  );
                                  if (!stillHasKyc) next.delete('credential');
                                }
                                return next;
                              });
                            }}
                            className="mt-0.5 h-[18px] w-[18px] border-[var(--color-muted)]/40 group-hover:border-[var(--color-muted)] data-[state=checked]:border-[var(--color-accent)] data-[disabled]:opacity-70"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <div className="font-mono text-[13px] leading-5 text-[var(--color-fg)]">
                                {meta.label}
                              </div>
                              {isCredentialAutoBundled && (
                                <span className="rounded-full border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-[var(--color-accent)]">
                                  Auto-included
                                </span>
                              )}
                            </div>
                            <div className="mt-1 text-[12px] leading-[1.45] text-[var(--color-muted)]">
                              {meta.description}
                              {isCredentialAutoBundled && (
                                <>
                                  {' '}
                                  <span className="text-[var(--color-muted)]">
                                    Required when any KYC scope is selected so firms can
                                    verify the credential on-chain without trusting Crivacy
                                    claims.
                                  </span>
                                </>
                              )}
                            </div>
                            {hint.length > 0 && (
                              <div className="mt-1 text-[11px] uppercase tracking-[0.06em] text-[var(--color-accent)]">
                                {hint}
                              </div>
                            )}
                          </div>
                          {/* Direct link to the scope's docs section.
                            * e.stopPropagation prevents the row label
                            * from toggling the checkbox when the user
                            * just wants documentation. */}
                          <Link
                            href={`/docs/oauth#scope-${id.replace(/:/g, '-')}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Open documentation for ${meta.label}`}
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
            </section>

            {/* Section 4, Client type */}
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
                Client Type
              </h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]/40 px-4 py-3">
                  <div>
                    <Label htmlFor="oauth-mode" className="text-sm">Live mode</Label>
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                      Issues a production{' '}
                      <code className="font-mono">crv_oauth_live_*</code> client id. Leave
                      off for a <code className="font-mono">crv_oauth_test_*</code>{' '}
                      sandbox client.
                    </p>
                  </div>
                  <Switch
                    id="oauth-mode"
                    checked={formMode === 'live'}
                    onCheckedChange={(checked) => setFormMode(checked ? 'live' : 'test')}
                  />
                </div>
                <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]/40 px-4 py-3">
                  <div>
                    <Label htmlFor="oauth-public" className="text-sm">Public client (PKCE only)</Label>
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                      No secret is generated. Use this for mobile / SPA clients that
                      can&apos;t keep a secret. PKCE is required at /authorize.
                    </p>
                  </div>
                  <Switch
                    id="oauth-public"
                    checked={formIsPublic}
                    onCheckedChange={(checked) => setFormIsPublic(checked)}
                  />
                </div>
              </div>
            </section>
          </div>
          <DialogFooter className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Link
              href="/docs/oauth#register-a-client"
              className="order-2 text-xs text-[var(--color-muted)] underline-offset-2 hover:text-[var(--color-fg)] hover:underline sm:order-1"
            >
              See the full OAuth client setup guide
            </Link>
            <div className="order-1 flex items-center justify-end gap-2 sm:order-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateClick} disabled={formName.length === 0}>
                Create client
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Secret reveal dialog, shared between first-time create and
       * the rotate-secret flow. Both credentials get identical
       * treatment: uppercase-tracked label → read-only input with
       * truncating monospace value + inline Copy button. Mirrors the
       * Stripe / GitHub OAuth reveal screens rather than the cramped
       * `<code>`-block-plus-optional-button earlier drafts. */}
      <Dialog
        open={createdSecret !== null || rotateResult !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedSecret(null);
            setRotateResult(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save your OAuth credentials</DialogTitle>
            <DialogDescription>
              The client secret is shown once. Copy it into your backend&apos;s secrets
              manager before closing this dialog, Crivacy cannot show it again.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <CredentialField
              label="client_id"
              value={(createdSecret ?? rotateResult)?.clientId ?? ''}
              hint="Public identifier. Safe to embed in front-end code."
            />
            <CredentialField
              label="client_secret"
              value={(createdSecret ?? rotateResult)?.secret ?? ''}
              hint="Confidential. Only store server-side in your secrets manager."
              sensitive
            />

            <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 px-4 py-3 text-xs text-[var(--color-warning)]">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="mt-[2px] h-4 w-4 shrink-0"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M18 10A8 8 0 1 1 2 10a8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm-1 3a.75.75 0 0 0-.75.75v4a.75.75 0 0 0 1.5 0v-4A.75.75 0 0 0 10 9Z"
                  clipRule="evenodd"
                />
              </svg>
              <span>
                Once this dialog closes, the secret is gone. Rotate-secret later only
                issues a <em>new</em> one, the current value cannot be retrieved.
              </span>
            </div>
          </div>

          <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end">
            {createdSecret !== null && (
              <Button
                variant="outline"
                onClick={() => {
                  const revealedId = createdSecret.clientId;
                  const match = clients.find((c) => c.clientId === revealedId);
                  setCreatedSecret(null);
                  if (match !== undefined) {
                    setIntegrationTarget(toIntegrationClient(match));
                  }
                }}
              >
                <Code className="h-3.5 w-3.5" />
                Show integration code
              </Button>
            )}
            <Button
              onClick={() => {
                setCreatedSecret(null);
                setRotateResult(null);
              }}
            >
              I&apos;ve saved it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <IntegrationQuickStartDrawer
        open={integrationTarget !== null}
        onOpenChange={(open) => {
          if (!open) setIntegrationTarget(null);
        }}
        client={integrationTarget}
      />

      <DestructiveReauthModal
        open={showCreateReauth}
        onOpenChange={setShowCreateReauth}
        audience="firm"
        title="Create OAuth client"
        description="Minting a client + revealing its secret can let an attacker impersonate your app on the consent screen. Confirm your identity to proceed."
        confirmLabel="Create client"
        onConfirm={handleCreateConfirmed}
      />

      <DestructiveReauthModal
        open={rotateTargetReauth !== null}
        onOpenChange={(open) => {
          if (!open) setRotateTargetReauth(null);
        }}
        audience="firm"
        title={`Rotate secret for ${rotateTargetReauth?.name ?? ''}`}
        description="Generating a new secret invalidates the current one immediately. The new value is shown once after this dialog closes. Confirm your identity to rotate."
        confirmLabel="Rotate secret"
        destructive
        onConfirm={handleRotateConfirmed}
      />

      {/* Revoke confirm (step 1, confirm intent) */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={`Revoke ${revokeTarget?.name ?? ''}?`}
        description="Revoking stops new authorize and token requests for this client. Users with valid consents keep their access until tokens expire, revoke individual consents from the user dashboard for an immediate kill."
        confirmLabel="Revoke"
        variant="destructive"
        onConfirm={handleRevokeClick}
      />

      {/* Revoke reauth (step 2, password + TOTP) */}
      <DestructiveReauthModal
        open={revokeTargetReauth !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTargetReauth(null);
        }}
        audience="firm"
        destructive
        title={`Revoke ${revokeTargetReauth?.name ?? ''}`}
        description="Revoking the client cascades to every active access token and consent grant for it. Confirm with your password and authenticator code."
        confirmLabel="Revoke client"
        onConfirm={handleRevokeConfirmed}
      />
    </div>
  );
}

/**
 * Compact credential row used inside each list card (NOT the reveal
 * dialog). Shows a small uppercase-tracked label on top, monospace
 * value below, optional inline copy button, and an optional hint
 * line beneath. Used for both `client_id` (copyable) and
 * `client_secret` placeholder (non-copyable, just visual parity).
 */
function InlineCredentialRow({
  label,
  value,
  copyable,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly copyable: boolean;
  readonly hint?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
        {label}
      </p>
      <div className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)]/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-fg)]">
          {value}
        </code>
        {copyable ? (
          <CopyButton
            value={value}
            iconOnly
            size="sm"
            aria-label={`Copy ${label}`}
          />
        ) : null}
      </div>
      {hint !== undefined && (
        <p className="mt-1 text-[11px] leading-[1.4] text-[var(--color-muted)]">{hint}</p>
      )}
    </div>
  );
}

/**
 * Read-only credential row used in the secret-reveal dialog.
 *
 * Visual contract (both the `client_id` row and the `client_secret`
 * row get identical treatment so the reveal screen doesn't look
 * half-finished):
 *
 *   LABEL (uppercase, tracked, muted)
 *   ┌──────────────────────────────────────── ┬───────┐
 *   │ monospace value (truncates w/ ellipsis) │ Copy  │
 *   └──────────────────────────────────────── ┴───────┘
 *   hint text (muted, one line)
 *
 * The value is an actual `<input readOnly>` instead of a `<code>`,
 * that way the browser's native horizontal-scroll + drag-to-select
 * still works on overflowing secrets, and keyboard users can
 * tab in + `Cmd/Ctrl+A` + `Cmd/Ctrl+C` without touching the
 * mouse.
 */
function CredentialField({
  label,
  value,
  hint,
  sensitive = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly sensitive?: boolean;
}) {
  const fieldId = `cred-${label}`;
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <label
          htmlFor={fieldId}
          className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]"
        >
          {label}
        </label>
        {sensitive && (
          <span className="rounded-full border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-warning)]">
            One-time
          </span>
        )}
      </div>
      <div className="flex items-stretch gap-0 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)]">
        <input
          id={fieldId}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 min-w-0 border-0 bg-transparent px-3 py-2.5 font-mono text-[13px] text-[var(--color-fg)] outline-none focus:ring-0"
          aria-label={label}
        />
        <CopyButton
          value={value}
          label="Copy"
          variant="ghost"
          className="shrink-0 rounded-none border-l border-[var(--color-border)] px-3"
        />
      </div>
      <p className="mt-1.5 text-[11px] text-[var(--color-muted)]">{hint}</p>
    </section>
  );
}
