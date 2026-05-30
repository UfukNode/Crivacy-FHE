'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Pencil,
  Trash2,
  Save,
  ChevronDown,
  ChevronRight,
  Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
import { PageHeader } from '@/components/shared/page-header';
import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';
import {
  useAdminRoleDetail,
  useAdminPermissionCatalog,
  useAdminRbacAction,
  type Permission,
  type RoleDetail,
} from '@/hooks/use-admin-rbac';
import { useAdminPermissions } from '@/hooks/use-admin-permissions';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Display order and labels for permission domains. */
const DOMAIN_ORDER: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'auth', label: 'Authentication' },
  { key: 'kyc', label: 'KYC Verification' },
  { key: 'credential', label: 'Credentials' },
  { key: 'ticket', label: 'Tickets' },
  { key: 'webhook', label: 'Webhooks' },
  { key: 'firm', label: 'Firms' },
  { key: 'admin', label: 'Administration' },
  { key: 'system', label: 'System' },
] as const;

/* -------------------------------------------------------------------------- */
/*  Loading skeleton                                                          */
/* -------------------------------------------------------------------------- */

function RoleDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-48" />
      <Skeleton className="h-64" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Role type badge                                                           */
/* -------------------------------------------------------------------------- */

function RoleTypeBadge({ role }: { readonly role: RoleDetail }) {
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
/*  Edit role dialog                                                          */
/* -------------------------------------------------------------------------- */

interface EditRoleDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly role: RoleDetail;
  readonly onUpdated: () => void;
}

function EditRoleDialog({ open, onOpenChange, role, onUpdated }: EditRoleDialogProps) {
  const [displayName, setDisplayName] = React.useState(role.displayName);
  const [description, setDescription] = React.useState(role.description ?? '');
  const [error, setError] = React.useState<string | null>(null);
  // BUG #58: chained reauth on save click, local validation runs
  // first to avoid an unnecessary password+TOTP prompt when the
  // display name is empty.
  const [showReauth, setShowReauth] = React.useState(false);
  const { execute } = useAdminRbacAction();

  // Sync form when role changes
  React.useEffect(() => {
    setDisplayName(role.displayName);
    setDescription(role.description ?? '');
    setError(null);
  }, [role.displayName, role.description]);

  function handleSaveClick() {
    const trimmedDisplayName = displayName.trim();
    if (!trimmedDisplayName) {
      setError('Display name is required.');
      return;
    }
    setError(null);
    setShowReauth(true);
  }

  async function handleSaveConfirmed({
    currentPassword,
    totpCode,
  }: { currentPassword: string; totpCode: string }) {
    const trimmedDescription = description.trim();
    const body: Record<string, unknown> = {
      currentPassword,
      totpCode,
      displayName: displayName.trim(),
      description: trimmedDescription === '' ? null : trimmedDescription,
    };

    const res = await execute(`/api/internal/admin/rbac/roles/${role.id}`, {
      method: 'PATCH',
      body,
    });

    if (!res.ok) {
      const responseBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = responseBody['error'] as Record<string, unknown> | undefined;
      throw new Error((err?.['message'] as string | undefined) ?? 'Failed to update role.');
    }

    toast.success('Role updated successfully.');
    onOpenChange(false);
    onUpdated();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Role</DialogTitle>
          <DialogDescription>
            Update the display name and description for this role.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {error !== null && (
            <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
              {error}
            </div>
          )}

          {/* Slug (read-only) */}
          <div className="space-y-2">
            <Label>Name (slug)</Label>
            <Input value={role.name} disabled />
            <p className="text-xs text-[var(--color-muted)]">
              Role slug cannot be changed after creation.
            </p>
          </div>

          {/* Display name */}
          <div className="space-y-2">
            <Label htmlFor="edit-role-display-name">Display Name</Label>
            <Input
              id="edit-role-display-name"
              value={displayName}
              onChange={(e) => { setDisplayName(e.target.value); }}
              autoComplete="off"
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="edit-role-description">Description</Label>
            <Textarea
              id="edit-role-description"
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
            onClick={() => { onOpenChange(false); }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveClick}
            disabled={!displayName.trim()}
          >
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
      <DestructiveReauthModal
        open={showReauth}
        onOpenChange={setShowReauth}
        audience="admin"
        title="Confirm role update"
        description="Re-authenticate to apply changes to this role's display name or description."
        confirmLabel="Save changes"
        onConfirm={handleSaveConfirmed}
      />
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  Permission domain section (collapsible)                                   */
/* -------------------------------------------------------------------------- */

interface PermissionDomainSectionProps {
  readonly domain: string;
  readonly label: string;
  readonly permissions: readonly Permission[];
  readonly grantedCodes: ReadonlySet<string>;
  readonly onToggle: (code: string) => void;
  readonly disabled: boolean;
}

function PermissionDomainSection({
  domain,
  label,
  permissions,
  grantedCodes,
  onToggle,
  disabled,
}: PermissionDomainSectionProps) {
  const [expanded, setExpanded] = React.useState(true);
  const grantedCount = permissions.filter((p) => grantedCodes.has(p.code)).length;

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)]">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface)]/50"
        onClick={() => { setExpanded((prev) => !prev); }}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />
          )}
          <span className="text-sm font-medium text-[var(--color-fg)]">{label}</span>
          <Badge variant="secondary" className="text-[10px]">
            {grantedCount}/{permissions.length}
          </Badge>
        </div>
        <span className="text-xs text-[var(--color-muted)]">{domain}</span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--color-border)] px-4 py-3">
          <div className="space-y-3">
            {permissions.map((permission) => {
              const isGranted = grantedCodes.has(permission.code);
              return (
                <div
                  key={permission.code}
                  className="flex items-start gap-3"
                >
                  <Checkbox
                    id={`perm-${permission.code}`}
                    checked={isGranted}
                    onCheckedChange={() => { onToggle(permission.code); }}
                    disabled={disabled}
                    aria-label={`${permission.name}: ${permission.description}`}
                  />
                  <div className="flex-1 space-y-0.5">
                    <label
                      htmlFor={`perm-${permission.code}`}
                      className={cn(
                        'flex items-center gap-2 text-sm font-medium',
                        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                      )}
                    >
                      <span className="text-[var(--color-fg)]">{permission.name}</span>
                      <TooltipProvider delayDuration={300}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3.5 w-3.5 text-[var(--color-muted)]" aria-hidden="true" />
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-xs">
                            <p className="text-xs">{permission.description}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </label>
                    <p className="font-mono text-[11px] text-[var(--color-muted)]">
                      {permission.code}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Permission grid                                                           */
/* -------------------------------------------------------------------------- */

interface PermissionGridProps {
  readonly role: RoleDetail;
  readonly canManage: boolean;
  readonly onPermissionsSaved: () => void;
}

function PermissionGrid({ role, canManage, onPermissionsSaved }: PermissionGridProps) {
  const { permissions, isLoading: permissionsLoading, error: permissionsError } = useAdminPermissionCatalog();
  const { execute } = useAdminRbacAction();
  // BUG #58: PUT /permissions is a privilege escalation surface —
  // a stolen-session attacker could grant themselves any permission.
  // Reauth chained on the Save click in both placements (header
  // button + sticky bottom bar).
  const [showReauth, setShowReauth] = React.useState(false);

  // Track the current set of granted permission codes (local state for editing)
  const [grantedCodes, setGrantedCodes] = React.useState<Set<string>>(() =>
    new Set(role.permissions.map((p) => p.code)),
  );

  // Sync when role data changes (e.g. after save)
  React.useEffect(() => {
    setGrantedCodes(new Set(role.permissions.map((p) => p.code)));
  }, [role.permissions]);

  // Check if there are unsaved changes
  const originalCodes = React.useMemo(
    () => new Set(role.permissions.map((p) => p.code)),
    [role.permissions],
  );

  const hasChanges = React.useMemo(() => {
    if (grantedCodes.size !== originalCodes.size) return true;
    for (const code of grantedCodes) {
      if (!originalCodes.has(code)) return true;
    }
    return false;
  }, [grantedCodes, originalCodes]);

  function handleToggle(code: string) {
    setGrantedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
  }

  async function handleSaveConfirmed({
    currentPassword,
    totpCode,
  }: { currentPassword: string; totpCode: string }) {
    const codes = Array.from(grantedCodes);
    const res = await execute(`/api/internal/admin/rbac/roles/${role.id}/permissions`, {
      method: 'PUT',
      body: { currentPassword, totpCode, permissions: codes },
    });

    if (!res.ok) {
      const responseBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = responseBody['error'] as Record<string, unknown> | undefined;
      throw new Error((err?.['message'] as string | undefined) ?? 'Failed to save permissions.');
    }

    toast.success('Permissions saved successfully.');
    onPermissionsSaved();
  }

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
    const result: { key: string; label: string; permissions: Permission[] }[] = [];

    // Add known domains in order
    for (const domain of DOMAIN_ORDER) {
      const domainPermissions = permissionsByDomain.get(domain.key);
      if (domainPermissions && domainPermissions.length > 0) {
        result.push({ key: domain.key, label: domain.label, permissions: domainPermissions });
      }
    }

    // Add any unknown domains at the end
    for (const [key, domainPermissions] of permissionsByDomain) {
      if (!DOMAIN_ORDER.some((d) => d.key === key)) {
        result.push({
          key,
          label: key.charAt(0).toUpperCase() + key.slice(1),
          permissions: domainPermissions,
        });
      }
    }

    return result;
  }, [permissionsByDomain]);

  // Read-only when the role itself is a system role OR when the caller
  // lacks the role_manage permission. Support / Admin tier admins can
  // browse the catalogue but never toggle checkboxes.
  const isReadOnly = role.isSystem || !canManage;

  if (permissionsLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  if (permissionsError) {
    return (
      <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
        Failed to load permissions catalogue.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-fg)]">Permissions</h2>
          <p className="text-sm text-[var(--color-muted)]">
            {isReadOnly
              ? 'System roles have fixed permissions that cannot be modified.'
              : `${grantedCodes.size} of ${permissions.length} permissions granted.`}
          </p>
        </div>
        {!isReadOnly && (
          <Button
            onClick={() => { setShowReauth(true); }}
            disabled={!hasChanges}
          >
            <Save className="mr-2 h-4 w-4" aria-hidden="true" />
            Save Permissions
          </Button>
        )}
      </div>

      {isReadOnly && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-3 py-2 text-sm text-[var(--color-warning)]">
          {role.isSystem
            ? 'This is a system role. Its permissions are managed by the application and cannot be modified.'
            : 'You do not have permission to modify role permissions. Contact a superadmin to make changes.'}
        </div>
      )}

      <div className="space-y-3">
        {orderedDomains.map((domain) => (
          <PermissionDomainSection
            key={domain.key}
            domain={domain.key}
            label={domain.label}
            permissions={domain.permissions}
            grantedCodes={grantedCodes}
            onToggle={handleToggle}
            disabled={isReadOnly}
          />
        ))}
      </div>

      {!isReadOnly && hasChanges && (
        <div className="sticky bottom-4 flex justify-end">
          <Button
            onClick={() => { setShowReauth(true); }}
            className="shadow-[var(--shadow-lg)]"
          >
            <Save className="mr-2 h-4 w-4" aria-hidden="true" />
            Save Permissions
          </Button>
        </div>
      )}
      <DestructiveReauthModal
        open={showReauth}
        onOpenChange={setShowReauth}
        audience="admin"
        title="Confirm permission changes"
        description={`Re-authenticate to update permissions on "${role.displayName}". Permission writes are a privilege-escalation surface and require step-up.`}
        confirmLabel="Save permissions"
        onConfirm={handleSaveConfirmed}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Admin RBAC role detail page.
 *
 * Shows role info card with edit/delete actions and a permission grid
 * grouped by domain with checkboxes for granting/revoking permissions.
 * System roles display permissions as read-only.
 */
export default function AdminRbacRoleDetailPage() {
  const params = useParams();
  const router = useRouter();
  const rawId = params?.['id'];
  const roleId = typeof rawId === 'string' ? rawId : null;
  const { role, error, isLoading, mutate } = useAdminRoleDetail(roleId);
  const { execute } = useAdminRbacAction();
  const { has: hasAdminPermission } = useAdminPermissions();

  const [editDialogOpen, setEditDialogOpen] = React.useState(false);
  const [deleteReauthOpen, setDeleteReauthOpen] = React.useState(false);

  async function handleDeleteConfirmed({
    currentPassword,
    totpCode,
  }: { currentPassword: string; totpCode: string }) {
    if (!role) return;
    const res = await execute(`/api/internal/admin/rbac/roles/${role.id}`, {
      method: 'DELETE',
      body: { currentPassword, totpCode },
    });

    if (!res.ok) {
      const responseBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = responseBody['error'] as Record<string, unknown> | undefined;
      throw new Error((err?.['message'] as string | undefined) ?? 'Failed to delete role.');
    }

    toast.success('Role deleted successfully.');
    router.push('/admin/rbac');
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Link
          href="/admin/rbac"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Roles
        </Link>
        <RoleDetailSkeleton />
      </div>
    );
  }

  if (error || !role) {
    const status = (error as { status?: number } | undefined)?.status;
    return (
      <div className="space-y-6">
        <Link
          href="/admin/rbac"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Roles
        </Link>
        <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-4">
          <p className="text-sm text-[var(--color-danger)]">
            {status === 404
              ? 'Role not found.'
              : 'Failed to load role. Please try again.'}
          </p>
          {status !== 404 && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => { void mutate(); }}
            >
              Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Two-layer gate:
  //   (1) Role-level flags, system roles are never editable, preset
  //       roles are never deletable. These are invariants of the role
  //       itself, not of the caller.
  //   (2) Caller-level permission, `admin.rbac.role_manage` (Superadmin
  //       per matrix) is required to *attempt* edit or delete at all.
  //       Support / Admin tier admins read the page but see no Edit or
  //       Delete button even for editable/deletable roles.
  const canManageRoles = hasAdminPermission('admin.rbac.role_manage');
  const canEdit = canManageRoles && !role.isSystem;
  const canDelete = canManageRoles && !role.isSystem && !role.isPreset;

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <PageHeader
        title={role.displayName}
        {...(role.description !== null ? { description: role.description } : {})}
        breadcrumbs={[
          { label: 'Roles & Permissions', href: '/admin/rbac' },
          { label: role.displayName },
        ]}
        actions={
          <div className="flex items-center gap-2">
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setEditDialogOpen(true); }}
              >
                <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                Edit
              </Button>
            )}
            {canDelete && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => { setDeleteReauthOpen(true); }}
              >
                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                Delete
              </Button>
            )}
          </div>
        }
      />

      {/* Role info card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Role Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Slug */}
            <div>
              <p className="text-xs font-medium text-[var(--color-muted)]">Name (slug)</p>
              <p className="mt-0.5 font-mono text-sm text-[var(--color-fg)]">{role.name}</p>
            </div>

            {/* User type */}
            <div>
              <p className="text-xs font-medium text-[var(--color-muted)]">User Type</p>
              <p className="mt-1">
                <Badge variant="outline" className="capitalize">
                  {role.userType}
                </Badge>
              </p>
            </div>

            {/* Role type */}
            <div>
              <p className="text-xs font-medium text-[var(--color-muted)]">Role Type</p>
              <p className="mt-1">
                <RoleTypeBadge role={role} />
              </p>
            </div>

            {/* Permissions count */}
            <div>
              <p className="text-xs font-medium text-[var(--color-muted)]">Permissions</p>
              <p className="mt-0.5 text-sm font-semibold text-[var(--color-fg)]">
                {role.permissions.length}
              </p>
            </div>
          </div>

          {/* Timestamps */}
          <Separator className="my-4" />
          <div className="flex flex-wrap gap-6 text-xs text-[var(--color-muted)]">
            <div>
              <span className="font-medium">Created: </span>
              {new Date(role.createdAt).toLocaleString()}
            </div>
            <div>
              <span className="font-medium">Updated: </span>
              {new Date(role.updatedAt).toLocaleString()}
            </div>
            {role.deletedAt && (
              <div className="text-[var(--color-danger)]">
                <span className="font-medium">Deleted: </span>
                {new Date(role.deletedAt).toLocaleString()}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Permission grid */}
      <PermissionGrid
        role={role}
        canManage={canManageRoles}
        onPermissionsSaved={() => { void mutate(); }}
      />

      {/* Edit dialog */}
      {canEdit && (
        <EditRoleDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          role={role}
          onUpdated={() => { void mutate(); }}
        />
      )}

      {/* Delete + reauth in one modal, description names the role so
          the admin sees the blast radius before re-authenticating. */}
      {canDelete && (
        <DestructiveReauthModal
          open={deleteReauthOpen}
          onOpenChange={setDeleteReauthOpen}
          audience="admin"
          title="Delete role"
          description={`Re-authenticate to soft-delete "${role.displayName}". The role is removed from every assigned user.`}
          confirmLabel="Delete role"
          destructive
          onConfirm={handleDeleteConfirmed}
        />
      )}
    </div>
  );
}
