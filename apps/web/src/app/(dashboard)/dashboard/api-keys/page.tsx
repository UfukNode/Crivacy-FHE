'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Plus, Key } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { LoadingButton } from '@/components/shared/loading-button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { CopyButton } from '@/components/shared/copy-button';
import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';
import { MaskedValue } from '@/components/shared/masked-value';
import { RelativeTime } from '@/components/shared/relative-time';
import { useFirmPermissions } from '@/hooks/use-firm-permissions';
import {
  API_KEY_SCOPE_METADATA,
  API_KEY_SCOPE_VALUES,
  type ApiKeyScopeValue,
} from '@/lib/enums';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  mode: 'live' | 'test';
  scopes: readonly string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface CreateApiKeyResponse {
  id: string;
  rawKey: string;
  prefix: string;
  name: string;
  mode: string;
  scopes: readonly string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
//
// Scope list derives from the canonical `ApiKeyScope` Zod enum via
// `@/lib/enums`. `satisfies Record<ApiKeyScopeValue, ...>` on the
// metadata map makes a future enum addition without a UI label
// surface here as a TS error, preventing silent drift.

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function KeysSkeleton() {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
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
 * API Keys management page -- list, create, revoke keys.
 */
export default function ApiKeysPage() {
  // The list endpoint wraps its payload in a `{ data: [...] }` envelope
  //, the public OpenAPI contract reserves that shape for future
  // pagination metadata. Unwrap to a flat array up front so every
  // downstream `keys.map/length` read works on the real list.
  const {
    data: rawKeys,
    error,
    isLoading,
    mutate,
  } = useSWR<{ readonly data: readonly ApiKeyItem[] }>('/api/internal/api-keys');
  const keys = rawKeys?.data;

  // Permission gates, mirror the server-side middleware checks so the
  // UI doesn't surface buttons the handler will 403. `canRevokeAny`
  // short-circuits the per-row ownership lookup when the caller has
  // the `.any` permission (Admin+).
  const { has: hasFirmPermission } = useFirmPermissions();
  const canCreate = hasFirmPermission('api_key.create');
  const canRevokeAny = hasFirmPermission('api_key.revoke.any');
  const canRevokeOwn = hasFirmPermission('api_key.revoke.own');

  // Create dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createMode, setCreateMode] = useState<'live' | 'test'>('test');
  const [createScopes, setCreateScopes] = useState<Set<ApiKeyScopeValue>>(
    new Set(API_KEY_SCOPE_VALUES),
  );
  const [showReauth, setShowReauth] = useState(false);

  // Newly created key display
  const [newKey, setNewKey] = useState<string | null>(null);

  // Revoke dialog state
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyItem | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [showRevokeReauth, setShowRevokeReauth] = useState(false);

  function toggleScope(scope: ApiKeyScopeValue) {
    setCreateScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
      }
      return next;
    });
  }

  function resetCreateForm() {
    setCreateName('');
    setCreateMode('test');
    setCreateScopes(new Set(API_KEY_SCOPE_VALUES));
  }

  function handleCreateClick() {
    if (createName.trim().length === 0) {
      toast.error('Please enter a key name.');
      return;
    }
    if (createScopes.size === 0) {
      toast.error('Please select at least one scope.');
      return;
    }
    setShowReauth(true);
  }

  // BUG #58: password + TOTP reauth before mint. Modal `onConfirm`
  // throws on backend rejection so the dialog can render the error
  // inline and let the user retry without losing their form input.
  async function handleCreateConfirmed({
    currentPassword,
    totpCode,
  }: {
    currentPassword: string;
    totpCode: string;
  }) {
    const res = await fetch('/api/internal/api-keys', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: createName.trim(),
        mode: createMode,
        scopes: [...createScopes],
        currentPassword,
        totpCode,
      }),
    });

    if (!res.ok) {
      const body = (await res.json()) as Record<string, unknown>;
      const err = body['error'] as Record<string, unknown> | undefined;
      throw new Error(
        (err?.['message'] as string) ?? 'Failed to create key.',
      );
    }

    const data = (await res.json()) as CreateApiKeyResponse;
    setNewKey(data.rawKey);
    setShowCreate(false);
    resetCreateForm();
    toast.success('API key created successfully.');
    void mutate();
  }

  function handleRevokeClick() {
    if (revokeTarget === null) return;
    setShowRevokeReauth(true);
  }

  // Cat 38 destructive-reauth (Page 7 closure): revoke now requires
  // password + TOTP. Modal `onConfirm` throws on backend rejection
  // so the dialog renders the error inline and the user can retry.
  async function handleRevokeConfirmed({
    currentPassword,
    totpCode,
  }: {
    currentPassword: string;
    totpCode: string;
  }) {
    if (revokeTarget === null) return;

    setRevoking(true);
    try {
      const res = await fetch(`/api/internal/api-keys/${revokeTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, totpCode }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = body['error'] as Record<string, unknown> | undefined;
        throw new Error(
          (err?.['message'] as string) ?? 'Failed to revoke key.',
        );
      }

      toast.success(`Key "${revokeTarget.name}" revoked.`);
      setRevokeTarget(null);
      void mutate();
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="API Keys"
        description="Manage your firm's API keys for KYC integration."
        actions={
          canCreate ? (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              Create Key
            </Button>
          ) : null
        }
      />

      {/* Newly created key banner */}
      {newKey !== null && (
        <Card className="border-[var(--color-success)]/30 bg-[var(--color-success)]/5">
          <CardContent className="pt-6">
            <p className="mb-3 text-sm font-medium text-[var(--color-success)]">
              Key created successfully. Copy it now, it won&apos;t be shown again.
            </p>
            <MaskedValue value={newKey} visiblePrefix={12} />
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => setNewKey(null)}
            >
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <Card className="border-[var(--color-danger)]/30">
          <CardContent className="pt-6">
            <p className="text-sm text-[var(--color-danger)]">
              Failed to load API keys. Please try refreshing the page.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {isLoading && <KeysSkeleton />}

      {/* Empty state */}
      {!isLoading && !error && keys && keys.length === 0 && (
        <EmptyState
          icon={<Key className="h-6 w-6" />}
          title="No API keys yet"
          description={
            canCreate
              ? 'Create an API key to start integrating with the Crivacy KYC API.'
              : 'No API keys exist yet. Ask an admin to create one.'
          }
          action={
            canCreate ? (
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4" />
                Create Key
              </Button>
            ) : undefined
          }
        />
      )}

      {/* Keys table */}
      {!isLoading && keys && keys.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-wider text-[var(--color-muted)]">
                    <th scope="col" className="pb-3 pr-4">Name</th>
                    <th scope="col" className="pb-3 pr-4">Prefix</th>
                    <th scope="col" className="pb-3 pr-4">Mode</th>
                    <th scope="col" className="pb-3 pr-4">Scopes</th>
                    <th scope="col" className="pb-3 pr-4">Created</th>
                    <th scope="col" className="pb-3 pr-4">Last Used</th>
                    <th scope="col" className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr
                      key={key.id}
                      className="border-b border-[var(--color-border)]/50"
                    >
                      <td className="max-w-[240px] truncate py-3 pr-4 font-medium" title={key.name}>{key.name}</td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-1">
                          <code className="text-xs text-[var(--color-muted)]">
                            {key.prefix}...
                          </code>
                          <CopyButton value={key.prefix} iconOnly />
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <Badge variant={key.mode === 'live' ? 'success' : 'warning'}>
                          {key.mode}
                        </Badge>
                      </td>
                      <td className="py-3 pr-4">
                        <span className="text-xs text-[var(--color-muted)]">
                          {key.scopes.length} scope{key.scopes.length !== 1 ? 's' : ''}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-[var(--color-muted)]">
                        <RelativeTime date={key.createdAt} className="text-xs" />
                      </td>
                      <td className="py-3 pr-4 text-[var(--color-muted)]">
                        {key.lastUsedAt !== null ? (
                          <RelativeTime date={key.lastUsedAt} className="text-xs" />
                        ) : (
                          <span className="text-xs">Never</span>
                        )}
                      </td>
                      <td className="py-3">
                        {key.revokedAt !== null ? (
                          <Badge variant="destructive">Revoked</Badge>
                        ) : canRevokeAny || canRevokeOwn ? (
                          // If caller only has `.own`, server enforces the
                          // creator match; button stays clickable and the
                          // 403 response surfaces a clear "ask an admin"
                          // message via the toast pipeline. Hiding based
                          // on creator would need the list response to
                          // include `createdByUserId`, which it does not
                          // today, follow-up when the API field is added.
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
                            onClick={() => setRevokeTarget(key)}
                          >
                            Revoke
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create dialog */}
      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          setShowCreate(open);
          if (!open) resetCreateForm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API Key</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="key-name">Key Name</Label>
              <Input
                id="key-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="Production API Key"
              />
            </div>
            <div className="space-y-2">
              <Label>Mode</Label>
              <Select
                value={createMode}
                onValueChange={(v) => setCreateMode(v as 'live' | 'test')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="live">Live</SelectItem>
                  <SelectItem value="test">Test</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Scopes</Label>
              <div className="space-y-2">
                {API_KEY_SCOPE_VALUES.map((scope) => {
                  const meta = API_KEY_SCOPE_METADATA[scope];
                  return (
                    <div key={scope} className="flex items-start gap-2">
                      <Checkbox
                        id={`scope-${scope}`}
                        checked={createScopes.has(scope)}
                        onCheckedChange={() => toggleScope(scope)}
                        className="mt-1"
                      />
                      <Label
                        htmlFor={`scope-${scope}`}
                        className="cursor-pointer"
                      >
                        <div className="font-mono text-xs">{meta.label}</div>
                        <div className="text-xs text-[var(--color-muted)]">
                          {meta.description}
                        </div>
                      </Label>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateClick}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DestructiveReauthModal
        open={showReauth}
        onOpenChange={setShowReauth}
        audience="firm"
        title="Create API key"
        description="API keys can call every firm-scoped endpoint via /api/v1/*. Enter your password and authenticator code to mint this key."
        confirmLabel="Create key"
        onConfirm={handleCreateConfirmed}
      />

      {/* Revoke confirmation dialog (step 1, confirm intent) */}
      <ConfirmDialog
        open={revokeTarget !== null && !showRevokeReauth}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke API Key"
        description={`Are you sure you want to revoke "${revokeTarget?.name ?? ''}"? This action cannot be undone and any integration using this key will stop working.`}
        confirmLabel="Revoke Key"
        variant="destructive"
        loading={revoking}
        onConfirm={handleRevokeClick}
      />

      {/* Revoke reauth dialog (step 2, password + TOTP) */}
      <DestructiveReauthModal
        open={showRevokeReauth}
        onOpenChange={(open) => {
          setShowRevokeReauth(open);
          if (!open) setRevokeTarget(null);
        }}
        audience="firm"
        destructive
        title="Revoke API key"
        description={`Revoking "${revokeTarget?.name ?? ''}" cannot be undone. Confirm with your password and authenticator code.`}
        confirmLabel="Revoke key"
        onConfirm={handleRevokeConfirmed}
      />
    </div>
  );
}
