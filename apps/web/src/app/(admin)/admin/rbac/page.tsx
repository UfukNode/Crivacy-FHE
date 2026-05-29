'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Plus, ShieldAlert, ShieldCheck, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';
import { useAdminRoles, useAdminRbacAction, type Role } from '@/hooks/use-admin-rbac';
import { useAdminPermissions } from '@/hooks/use-admin-permissions';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const USER_TYPE_TABS = [
  { value: 'all', label: 'All' },
  { value: 'customer', label: 'Customer' },
  { value: 'firm', label: 'Firm' },
  { value: 'admin', label: 'Admin' },
] as const;

const USER_TYPE_OPTIONS = [
  { value: 'customer', label: 'Customer' },
  { value: 'firm', label: 'Firm' },
  { value: 'admin', label: 'Admin' },
] as const;

/* -------------------------------------------------------------------------- */
/*  Role type badge                                                           */
/* -------------------------------------------------------------------------- */

function RoleTypeBadge({ role }: { readonly role: Role }) {
  if (role.isSystem) {
    return (
      <Badge variant="destructive" className="text-[10px]">
        <ShieldAlert className="mr-1 h-3 w-3" aria-hidden="true" />
        System
      </Badge>
    );
  }
  if (role.isPreset) {
    return (
      <Badge variant="default" className="text-[10px]">
        <ShieldCheck className="mr-1 h-3 w-3" aria-hidden="true" />
        Preset
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="text-[10px]">
      <Pencil className="mr-1 h-3 w-3" aria-hidden="true" />
      Custom
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/*  Loading skeleton                                                          */
/* -------------------------------------------------------------------------- */

function RolesTableSkeleton() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Create role dialog                                                        */
/* -------------------------------------------------------------------------- */

interface CreateRoleDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: () => void;
}

function CreateRoleDialog({ open, onOpenChange, onCreated }: CreateRoleDialogProps) {
  const [name, setName] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [userType, setUserType] = React.useState('customer');
  const [description, setDescription] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  // BUG #58: reauth gate sits between Create click and the POST.
  // Local validation runs first so the admin doesn't reauth only to
  // be told the slug is malformed; reauth modal shows backend errors
  // (duplicate name, permission denied) inline.
  const [showReauth, setShowReauth] = React.useState(false);
  const { execute } = useAdminRbacAction();

  function resetForm() {
    setName('');
    setDisplayName('');
    setUserType('customer');
    setDescription('');
    setError(null);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      resetForm();
    }
    onOpenChange(nextOpen);
  }

  function handleCreateClick() {
    const trimmedName = name.trim();
    const trimmedDisplayName = displayName.trim();

    if (!trimmedName) {
      setError('Name (slug) is required.');
      return;
    }
    if (!trimmedDisplayName) {
      setError('Display name is required.');
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(trimmedName)) {
      setError('Name must be a valid slug: lowercase letters, digits, underscores. Must start with a letter.');
      return;
    }

    setError(null);
    setShowReauth(true);
  }

  async function handleCreateConfirmed({
    currentPassword,
    totpCode,
  }: { currentPassword: string; totpCode: string }) {
    const body: Record<string, unknown> = {
      currentPassword,
      totpCode,
      name: name.trim(),
      displayName: displayName.trim(),
      userType,
    };
    const trimmedDescription = description.trim();
    if (trimmedDescription) {
      body['description'] = trimmedDescription;
    }

    const res = await execute('/api/internal/admin/rbac/roles', {
      method: 'POST',
      body,
    });

    if (!res.ok) {
      const responseBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = responseBody['error'] as Record<string, unknown> | undefined;
      throw new Error((err?.['message'] as string | undefined) ?? 'Failed to create role.');
    }

    toast.success('Role created successfully.');
    handleOpenChange(false);
    onCreated();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Custom Role</DialogTitle>
          <DialogDescription>
            Create a new role with a unique slug name and display name.
            Permissions can be assigned after creation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {error !== null && (
            <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
              {error}
            </div>
          )}

          {/* Name (slug) */}
          <div className="space-y-2">
            <Label htmlFor="create-role-name">Name (slug)</Label>
            <Input
              id="create-role-name"
              value={name}
              onChange={(e) => { setName(e.target.value); }}
              placeholder="e.g. firm_viewer"
              autoComplete="off"
            />
            <p className="text-xs text-[var(--color-muted)]">
              Lowercase letters, digits, underscores. Used as the unique identifier.
            </p>
          </div>

          {/* Display name */}
          <div className="space-y-2">
            <Label htmlFor="create-role-display-name">Display Name</Label>
            <Input
              id="create-role-display-name"
              value={displayName}
              onChange={(e) => { setDisplayName(e.target.value); }}
              placeholder="e.g. Firm Viewer"
              autoComplete="off"
            />
          </div>

          {/* User type */}
          <div className="space-y-2">
            <Label htmlFor="create-role-user-type">User Type</Label>
            <Select value={userType} onValueChange={setUserType}>
              <SelectTrigger id="create-role-user-type">
                <SelectValue placeholder="Select user type" />
              </SelectTrigger>
              <SelectContent>
                {USER_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="create-role-description">Description (optional)</Label>
            <Textarea
              id="create-role-description"
              value={description}
              onChange={(e) => { setDescription(e.target.value); }}
              placeholder="What is this role used for?"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => { handleOpenChange(false); }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreateClick}
            disabled={!name.trim() || !displayName.trim()}
          >
            Create Role
          </Button>
        </DialogFooter>
      </DialogContent>
      <DestructiveReauthModal
        open={showReauth}
        onOpenChange={setShowReauth}
        audience="admin"
        title="Confirm role creation"
        description="Re-authenticate to create the role. The new role starts with no permissions; assign them after creation."
        confirmLabel="Create role"
        onConfirm={handleCreateConfirmed}
      />
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  Roles table                                                               */
/* -------------------------------------------------------------------------- */

interface RolesTableProps {
  readonly roles: readonly Role[];
}

function RolesTable({ roles }: RolesTableProps) {
  const router = useRouter();

  return (
    <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">
              Name
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">
              Display Name
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">
              User Type
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">
              Type
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {roles.map((role) => (
            <tr
              key={role.id}
              className="cursor-pointer transition-colors hover:bg-[var(--color-surface)]/50"
              onClick={() => { router.push(`/admin/rbac/roles/${role.id}`); }}
            >
              <td className="px-4 py-3">
                <span className="font-mono text-xs text-[var(--color-accent)]">
                  {role.name}
                </span>
              </td>
              <td className="px-4 py-3 font-medium text-[var(--color-fg)]">
                {role.displayName}
              </td>
              <td className="px-4 py-3">
                <Badge variant="outline" className="text-[10px] capitalize">
                  {role.userType}
                </Badge>
              </td>
              <td className="px-4 py-3">
                <RoleTypeBadge role={role} />
              </td>
              <td className="px-4 py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    router.push(`/admin/rbac/roles/${role.id}`);
                  }}
                >
                  View
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Tab content                                                               */
/* -------------------------------------------------------------------------- */

interface RolesTabContentProps {
  readonly userType?: string;
  readonly onRolesLoaded?: (count: number) => void;
}

function RolesTabContent({ userType, onRolesLoaded }: RolesTabContentProps) {
  const { roles, error, isLoading, mutate } = useAdminRoles(userType);

  React.useEffect(() => {
    if (!isLoading && onRolesLoaded) {
      onRolesLoaded(roles.length);
    }
  }, [roles.length, isLoading, onRolesLoaded]);

  if (isLoading) {
    return <RolesTableSkeleton />;
  }

  if (error) {
    return (
      <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
        Failed to load roles.
        <Button
          variant="ghost"
          size="sm"
          className="ml-2"
          onClick={() => { void mutate(); }}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (roles.length === 0) {
    return (
      <EmptyState
        icon={<Shield className="h-6 w-6" aria-hidden="true" />}
        title="No roles found"
        description={
          userType
            ? `No roles found for the "${userType}" user type.`
            : 'No roles have been created yet.'
        }
      />
    );
  }

  return <RolesTable roles={roles} />;
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Admin RBAC roles list page.
 *
 * Shows all roles filtered by user type tabs (All, Customer, Firm, Admin).
 * Each row navigates to the role detail page. Create role dialog for custom roles.
 */
export default function AdminRbacPage() {
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState('all');

  // Role mutations are Superadmin-only per matrix (`admin.rbac.role_manage`).
  // Support + Admin see the catalogue in read mode; only Superadmin
  // gets the Create Role affordance.
  const { has: hasAdminPermission } = useAdminPermissions();
  const canManageRoles = hasAdminPermission('admin.rbac.role_manage');

  // We need a way to trigger re-fetch across all tabs after creation.
  // Using a key that increments forces SWR to re-mount and refetch.
  const [refreshKey, setRefreshKey] = React.useState(0);

  function handleRoleCreated() {
    setRefreshKey((prev) => prev + 1);
  }

  return (
    <div>
      <PageHeader
        title="Roles & Permissions"
        description="Manage access control roles and their assigned permissions across the system."
        actions={
          canManageRoles ? (
            <Button onClick={() => { setCreateDialogOpen(true); }}>
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              Create Role
            </Button>
          ) : null
        }
      />

      <div className="mt-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            {USER_TYPE_TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {USER_TYPE_TABS.map((tab) => (
            <TabsContent key={tab.value} value={tab.value}>
              <div className="mt-4" key={refreshKey}>
                <RolesTabContent
                  {...(tab.value !== 'all' ? { userType: tab.value } : {})}
                />
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>

      <CreateRoleDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={handleRoleCreated}
      />
    </div>
  );
}
