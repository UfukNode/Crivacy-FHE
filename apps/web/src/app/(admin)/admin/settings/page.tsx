'use client';

import useSWR from 'swr';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Admin profile (read-only). Admin accounts have no editable surface
 * beyond credentials (Security tab) and role (managed by another
 * admin), so this page is intentionally a minimal info card, it
 * exists mainly to give the settings tab strip a default landing.
 */
interface AdminMeResponse {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
}

export default function AdminSettingsProfilePage() {
  const { data, isLoading } = useSWR<AdminMeResponse>('/api/internal/admin/me');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Admin profile</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading || data === undefined ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-6 w-full" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <p className="text-xs font-medium text-[var(--color-muted)]">Email</p>
                <p className="font-mono text-sm">{data.email}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-[var(--color-muted)]">Display name</p>
                <p className="text-sm">{data.displayName}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-[var(--color-muted)]">Role</p>
                <p className="text-sm font-medium capitalize">{data.role}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-[var(--color-muted)]">Admin ID</p>
                <p className="font-mono text-xs text-[var(--color-muted)]">{data.id}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
