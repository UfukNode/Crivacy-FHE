'use client';

/**
 * Customer-facing "Connected apps" page.
 *
 * Route: `/settings/connected-apps`. Shows every firm that has been
 * granted an active OAuth consent plus any revoked history, with
 * per-row revoke action. Revoking cascades into access tokens (see
 * `revokeConsent` in the oauth repository).
 */

import { useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';

interface ConsentRow {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly clientDescription: string | null;
  readonly clientLogoUrl: string | null;
  readonly clientHomepageUrl: string | null;
  readonly scopes: readonly string[];
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly isActive: boolean;
}

interface ListResponse {
  readonly data: readonly ConsentRow[];
}

export default function ConnectedAppsPage() {
  const { data, error, isLoading, mutate } = useSWR<ListResponse>('/api/customer/oauth-consents');
  const [revokeTarget, setRevokeTarget] = useState<ConsentRow | null>(null);
  const [revoking, setRevoking] = useState(false);

  async function handleRevoke(): Promise<void> {
    if (revokeTarget === null) return;
    setRevoking(true);
    try {
      const res = await fetch(`/api/customer/oauth-consents/${revokeTarget.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        toast.error('Failed to revoke access.');
        return;
      }
      toast.success(`Revoked ${revokeTarget.clientName}.`);
      setRevokeTarget(null);
      void mutate();
    } catch {
      toast.error('Network error.');
    } finally {
      setRevoking(false);
    }
  }

  const consents = data?.data ?? [];
  const active = consents.filter((c) => c.isActive);
  const inactive = consents.filter((c) => !c.isActive);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connected apps"
        description="Apps you've approved to verify your identity via Crivacy. Revoking here stops new sessions immediately."
      />

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-[var(--color-danger)]">
            Failed to load connected apps. Please refresh the page.
          </CardContent>
        </Card>
      )}

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {!isLoading && consents.length === 0 && (
        <EmptyState
          title="No connected apps"
          description="When you approve access on a partner site, that app will show up here."
        />
      )}

      {!isLoading && active.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-[var(--color-muted)]">Active</h2>
          <div className="space-y-3">
            {active.map((consent) => (
              <ConsentCard
                key={consent.id}
                consent={consent}
                onRevoke={() => setRevokeTarget(consent)}
              />
            ))}
          </div>
        </section>
      )}

      {!isLoading && inactive.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-[var(--color-muted)]">History</h2>
          <div className="space-y-3">
            {inactive.map((consent) => (
              <ConsentCard key={consent.id} consent={consent} onRevoke={null} />
            ))}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={`Disconnect ${revokeTarget?.clientName ?? ''}?`}
        description="This removes their access immediately. If you approve this app again later, it will be treated as a new grant."
        confirmLabel="Disconnect"
        variant="destructive"
        loading={revoking}
        onConfirm={handleRevoke}
      />
    </div>
  );
}

function ConsentCard({
  consent,
  onRevoke,
}: {
  consent: ConsentRow;
  onRevoke: (() => void) | null;
}) {
  return (
    <Card className={consent.isActive ? undefined : 'opacity-60'}>
      <CardContent className="flex flex-wrap items-start gap-4 p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)]">
          {consent.clientLogoUrl !== null ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={consent.clientLogoUrl}
              alt=""
              aria-hidden="true"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-sm font-semibold text-[var(--color-muted)]">
              {consent.clientName.charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{consent.clientName}</h3>
            {consent.revokedAt !== null && <Badge variant="destructive">revoked</Badge>}
            {!consent.isActive && consent.revokedAt === null && (
              <Badge variant="secondary">expired</Badge>
            )}
          </div>
          {consent.clientDescription !== null && (
            <p className="mt-1 text-xs text-[var(--color-muted)]">{consent.clientDescription}</p>
          )}

          <div className="mt-2 flex flex-wrap gap-1">
            {consent.scopes.map((scope) => (
              <Badge key={scope} variant="secondary" className="font-mono text-[10px]">
                {scope}
              </Badge>
            ))}
          </div>

          <p className="mt-2 text-xs text-[var(--color-muted)]">
            Granted {new Date(consent.grantedAt).toLocaleDateString()}
            {consent.lastUsedAt !== null && (
              <> · last used {new Date(consent.lastUsedAt).toLocaleDateString()}</>
            )}
            {consent.isActive && (
              <> · expires {new Date(consent.expiresAt).toLocaleDateString()}</>
            )}
          </p>

          {consent.clientHomepageUrl !== null && (
            <p className="mt-1 text-xs">
              <a
                href={consent.clientHomepageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-accent)] underline-offset-2 hover:underline"
              >
                Visit app →
              </a>
            </p>
          )}
        </div>

        {onRevoke !== null && (
          <Button variant="outline" size="sm" onClick={onRevoke}>
            Disconnect
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
