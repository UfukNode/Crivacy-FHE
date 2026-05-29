'use client';

import * as React from 'react';
import { Shield, Lock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { SearchInput } from '@/components/shared/search-input';
import { useAdminPermissionCatalog, type Permission } from '@/hooks/use-admin-rbac';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Display order and labels for permission domains. */
const DOMAIN_META: Record<string, { label: string; description: string }> = {
  auth: {
    label: 'Authentication',
    description: 'Login, registration, session, and password management.',
  },
  kyc: {
    label: 'KYC Verification',
    description: 'Know Your Customer identity verification workflows.',
  },
  credential: {
    label: 'Credentials',
    description: 'KYC credential issuance, revocation, and viewing.',
  },
  ticket: {
    label: 'Tickets',
    description: 'Support ticket creation, management, and replies.',
  },
  webhook: {
    label: 'Webhooks',
    description: 'Webhook endpoint configuration and delivery logs.',
  },
  firm: {
    label: 'Firms',
    description: 'Firm account management, members, and settings.',
  },
  admin: {
    label: 'Administration',
    description: 'Admin panel access, user management, and configuration.',
  },
  system: {
    label: 'System',
    description: 'System-level operations, health checks, and maintenance.',
  },
};

const DOMAIN_ORDER = [
  'auth', 'kyc', 'credential', 'ticket', 'webhook', 'firm', 'admin', 'system',
] as const;

/* -------------------------------------------------------------------------- */
/*  Loading skeleton                                                          */
/* -------------------------------------------------------------------------- */

function PermissionsSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-40 w-full" />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Domain card                                                               */
/* -------------------------------------------------------------------------- */

interface PermissionDomainCardProps {
  readonly domain: string;
  readonly label: string;
  readonly description: string;
  readonly permissions: readonly Permission[];
  readonly searchQuery: string;
}

function PermissionDomainCard({
  domain,
  label,
  description,
  permissions,
  searchQuery,
}: PermissionDomainCardProps) {
  // Filter permissions by search query
  const filteredPermissions = React.useMemo(() => {
    if (!searchQuery) return permissions;
    const query = searchQuery.toLowerCase();
    return permissions.filter(
      (p) =>
        p.code.toLowerCase().includes(query) ||
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query),
    );
  }, [permissions, searchQuery]);

  if (filteredPermissions.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{label}</CardTitle>
            <Badge variant="secondary" className="text-[10px]">
              {filteredPermissions.length}
            </Badge>
          </div>
          <span className="font-mono text-xs text-[var(--color-muted)]">{domain}</span>
        </div>
        <p className="text-sm text-[var(--color-muted)]">{description}</p>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-[var(--color-border)]">
          {filteredPermissions.map((permission) => (
            <div key={permission.code} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div className="flex-1 space-y-0.5">
                  <p className="text-sm font-medium text-[var(--color-fg)]">
                    {permission.name}
                  </p>
                  <p className="text-sm text-[var(--color-muted)]">
                    {permission.description}
                  </p>
                </div>
                <code className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[11px] text-[var(--color-muted)]">
                  {permission.code}
                </code>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Admin RBAC permission catalogue page.
 *
 * Read-only display of all system permissions grouped by domain.
 * Includes a search input to filter permissions by code, name, or description.
 * Permissions are code-defined and cannot be edited from this interface.
 */
export default function AdminRbacPermissionsPage() {
  const { permissions, error, isLoading, mutate } = useAdminPermissionCatalog();
  const [search, setSearch] = React.useState('');

  // Group permissions by domain
  const permissionsByDomain = React.useMemo(() => {
    const map = new Map<string, Permission[]>();
    for (const permission of permissions) {
      const existing = map.get(permission.domain);
      if (existing) {
        existing.push(permission);
      } else {
        map.set(permission.domain, [permission]);
      }
    }
    return map;
  }, [permissions]);

  // Build ordered list of domain sections
  const orderedDomains = React.useMemo(() => {
    const result: { key: string; label: string; description: string; permissions: Permission[] }[] = [];

    // Add known domains in order
    for (const domainKey of DOMAIN_ORDER) {
      const domainPermissions = permissionsByDomain.get(domainKey);
      const meta = DOMAIN_META[domainKey];
      if (domainPermissions && domainPermissions.length > 0 && meta) {
        result.push({
          key: domainKey,
          label: meta.label,
          description: meta.description,
          permissions: domainPermissions,
        });
      }
    }

    // Add any unknown domains at the end
    for (const [key, domainPermissions] of permissionsByDomain) {
      if (!DOMAIN_ORDER.includes(key as typeof DOMAIN_ORDER[number])) {
        result.push({
          key,
          label: key.charAt(0).toUpperCase() + key.slice(1),
          description: `Permissions in the ${key} domain.`,
          permissions: domainPermissions,
        });
      }
    }

    return result;
  }, [permissionsByDomain]);

  // Count total visible permissions after search filter
  const visibleCount = React.useMemo(() => {
    if (!search) return permissions.length;
    const query = search.toLowerCase();
    return permissions.filter(
      (p) =>
        p.code.toLowerCase().includes(query) ||
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query),
    ).length;
  }, [permissions, search]);

  return (
    <div>
      <PageHeader
        title="Permission Catalogue"
        description={`All system-defined permissions (${permissions.length} total). Permissions are code-defined and cannot be modified from this interface.`}
        breadcrumbs={[
          { label: 'Roles & Permissions', href: '/admin/rbac' },
          { label: 'Permission Catalogue' },
        ]}
      />

      {/* Search */}
      <div className="mt-6 flex items-center gap-3">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search permissions by code, name, or description..."
          className="max-w-md"
        />
        {search && (
          <p className="text-sm text-[var(--color-muted)]">
            {visibleCount} of {permissions.length} permissions match
          </p>
        )}
      </div>

      {/* Content */}
      <div className="mt-6 space-y-4">
        {/* Error state */}
        {error && (
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
            Failed to load permissions.
            <Button
              variant="ghost"
              size="sm"
              className="ml-2"
              onClick={() => { void mutate(); }}
            >
              Retry
            </Button>
          </div>
        )}

        {/* Loading state */}
        {isLoading ? (
          <PermissionsSkeleton />
        ) : permissions.length === 0 ? (
          <EmptyState
            icon={<Lock className="h-6 w-6" aria-hidden="true" />}
            title="No permissions found"
            description="No system permissions have been defined yet."
          />
        ) : visibleCount === 0 ? (
          <EmptyState
            icon={<Shield className="h-6 w-6" aria-hidden="true" />}
            title="No matching permissions"
            description={`No permissions match "${search}". Try a different search term.`}
          />
        ) : (
          orderedDomains.map((domain) => (
            <PermissionDomainCard
              key={domain.key}
              domain={domain.key}
              label={domain.label}
              description={domain.description}
              permissions={domain.permissions}
              searchQuery={search}
            />
          ))
        )}
      </div>
    </div>
  );
}
