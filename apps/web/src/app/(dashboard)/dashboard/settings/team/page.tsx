'use client';

import * as React from 'react';
import { Lock, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';
import { LoadingButton } from '@/components/shared/loading-button';
import { UserAvatar } from '@/components/shared/user-avatar';
import { RelativeTime } from '@/components/shared/relative-time';
import {
  FIRM_ROLES,
  canAssignRole,
  canManageRole,
  isFirmRole,
} from '@/lib/firm/roles';
import { useFirmPermissions } from '@/hooks/use-firm-permissions';
import {
  useFirmTeam,
  useFirmTeamAction,
  type FirmTeamMember,
  type FirmTeamViewer,
} from '@/hooks/use-firm-team';

function roleLabel(id: string): string {
  return FIRM_ROLES.find((r) => r.id === id)?.label ?? id;
}

interface InviteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly viewer: FirmTeamViewer;
  readonly onInvited: () => void | Promise<void>;
}

function InviteDialog({ open, onOpenChange, viewer, onInvited }: InviteDialogProps) {
  const { execute } = useFirmTeamAction();
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<string>('member');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setEmail('');
      setRole('member');
      setSubmitting(false);
      setError(null);
    }
  }, [open]);

  const assignableRoles = React.useMemo(
    () => FIRM_ROLES.filter((r) => canAssignRole(viewer.role, r.id)),
    [viewer.role],
  );

  async function handleSubmit(): Promise<void> {
    const trimmed = email.trim().toLowerCase();
    if (trimmed.length === 0) {
      setError('Please enter an email.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await execute('/api/internal/firm/users', {
        method: 'POST',
        body: { email: trimmed, role },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = payload['error'] as Record<string, unknown> | undefined;
        setError((err?.['message'] as string | undefined) ?? 'Failed to send invite.');
        return;
      }
      await onInvited();
      onOpenChange(false);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>
            We will send a welcome email with a link to set a password and
            enable two-factor authentication.
          </DialogDescription>
        </DialogHeader>

        {error !== null && (
          <div
            role="alert"
            className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]"
          >
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
              placeholder="teammate@acme.com"
              disabled={submitting}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole} disabled={submitting}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assignableRoles.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    <span className="font-medium">{r.label}</span>
                    <span className="ml-2 text-xs text-[var(--color-muted)]">
                      {r.description}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
          <LoadingButton
            loading={submitting}
            onClick={() => {
              void handleSubmit();
            }}
            disabled={email.trim().length === 0}
          >
            Send invite
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface MemberRowProps {
  readonly member: FirmTeamMember;
  readonly viewer: FirmTeamViewer;
  readonly onChangeRole: (member: FirmTeamMember, newRole: string) => void;
  readonly onRemove: (member: FirmTeamMember) => void;
  readonly pending: boolean;
}

function MemberRow({ member, viewer, onChangeRole, onRemove, pending }: MemberRowProps) {
  const isSelf = member.id === viewer.id;
  const canManage = canManageRole(viewer.role, member.role) && !isSelf;

  const assignableRoles = React.useMemo(
    () => FIRM_ROLES.filter((r) => canAssignRole(viewer.role, r.id)),
    [viewer.role],
  );

  const statusBadge =
    member.status === 'locked'
      ? { label: 'Locked', variant: 'destructive' as const }
      : member.status === 'invited'
        ? { label: 'Invite pending', variant: 'warning' as const }
        : null;

  return (
    <li className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
      <UserAvatar user={{ id: member.id, displayName: member.email }} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-medium text-[var(--color-fg)]">
            {member.email}
            {isSelf && (
              <span className="ml-1 text-xs font-normal text-[var(--color-muted)]">(you)</span>
            )}
          </p>
          {statusBadge !== null && (
            <Badge variant={statusBadge.variant} className="shrink-0 px-1.5 py-0 text-[10px]">
              {statusBadge.label}
            </Badge>
          )}
        </div>
        <p className="truncate text-xs text-[var(--color-muted)]">
          {roleLabel(member.role)}
          {member.lastLoginAt !== null && (
            <>
              {' · last seen '}
              <RelativeTime date={member.lastLoginAt} />
            </>
          )}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {canManage && isFirmRole(member.role) ? (
          <Select
            value={member.role}
            onValueChange={(next) => {
              if (next !== member.role) {
                void onChangeRole(member, next);
              }
            }}
            disabled={pending}
          >
            <SelectTrigger className="h-8 w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {assignableRoles.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.label}
                </SelectItem>
              ))}
              {/* Surface the current role even if it isn't assignable
                  (e.g. viewer looking at an owner) so the Select value
                  doesn't appear blank. */}
              {!assignableRoles.some((r) => r.id === member.role) && isFirmRole(member.role) && (
                <SelectItem value={member.role} disabled>
                  {roleLabel(member.role)}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-xs text-[var(--color-muted)]">{roleLabel(member.role)}</span>
        )}
        {canManage && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onRemove(member);
            }}
            disabled={pending}
            aria-label={`Remove ${member.email}`}
            title={`Remove ${member.email}`}
            className="h-8 px-2"
          >
            <Lock className="h-4 w-4 text-[var(--color-danger)]" aria-hidden="true" />
          </Button>
        )}
      </div>
    </li>
  );
}

export default function FirmTeamPage() {
  const { members, viewer, isLoading, error, mutate } = useFirmTeam();
  const { execute } = useFirmTeamAction();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<FirmTeamMember | null>(null);
  const [removeTargetReauth, setRemoveTargetReauth] = React.useState<FirmTeamMember | null>(null);
  const [roleChangeTarget, setRoleChangeTarget] = React.useState<{
    readonly member: FirmTeamMember;
    readonly newRole: string;
  } | null>(null);
  const [pending, setPending] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  // RBAC-driven invite gate, the legacy hierarchy shortcut
  // (`hasCapability(viewer.role, 'manageTeam')`) always produced the
  // same answer as `has('firm.user.invite')` while every user was
  // backfilled to their hierarchy-matching preset, but the two
  // diverge the moment a custom role enters the picture. Align on
  // the permission set so UI tracks whatever the server enforces.
  const { has: hasFirmPermission } = useFirmPermissions();
  const canInvite = viewer !== null && hasFirmPermission('firm.user.invite');

  function handleChangeRole(member: FirmTeamMember, newRole: string): void {
    setActionError(null);
    setRoleChangeTarget({ member, newRole });
  }

  // Cat 38 destructive-reauth (Page 7 closure): role change is the
  // privilege-escalation primitive, must be password+TOTP-gated.
  async function handleRoleChangeConfirmed({
    currentPassword,
    totpCode,
  }: {
    currentPassword: string;
    totpCode: string;
  }): Promise<void> {
    if (roleChangeTarget === null) return;
    const { member, newRole } = roleChangeTarget;
    setPending(true);
    try {
      const res = await execute(`/api/internal/firm/users/${member.id}`, {
        method: 'PATCH',
        body: { role: newRole, currentPassword, totpCode },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = payload['error'] as Record<string, unknown> | undefined;
        throw new Error(
          (err?.['message'] as string | undefined) ?? 'Failed to change role.',
        );
      }
      setRoleChangeTarget(null);
      await mutate();
    } finally {
      setPending(false);
    }
  }

  function handleRemoveConfirmClick(): void {
    if (removeTarget === null) return;
    setRemoveTargetReauth(removeTarget);
    setRemoveTarget(null);
  }

  // Cat 38 destructive-reauth (Page 7 closure): teammate removal
  // locks the row + burns invites. Password+TOTP gate prevents a
  // stolen owner/admin session from offboarding teammates silently.
  async function handleRemoveConfirmed({
    currentPassword,
    totpCode,
  }: {
    currentPassword: string;
    totpCode: string;
  }): Promise<void> {
    if (removeTargetReauth === null) return;
    setPending(true);
    try {
      const res = await execute(`/api/internal/firm/users/${removeTargetReauth.id}`, {
        method: 'DELETE',
        body: { currentPassword, totpCode },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = payload['error'] as Record<string, unknown> | undefined;
        throw new Error(
          (err?.['message'] as string | undefined) ?? 'Failed to remove teammate.',
        );
      }
      setRemoveTargetReauth(null);
      await mutate();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Section header + primary CTA. The page title + shared
          description already live in the settings layout's tab
          bar, so this block only carries the per-page subcopy and
          the action button. */}
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-[var(--color-muted)]">
          Invite teammates, change roles, or revoke access. At least one
          owner is always required.
        </p>
        {canInvite && (
          <Button
            onClick={() => {
              setInviteOpen(true);
            }}
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            Invite teammate
          </Button>
        )}
      </div>

      {actionError !== null && (
        <div
          role="alert"
          className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]"
        >
          {actionError}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Members</CardTitle>
        </CardHeader>
        <CardContent>
          {error !== undefined && (
            <p className="text-sm text-[var(--color-danger)]">Failed to load team.</p>
          )}
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : members.length === 0 || viewer === null ? (
            <p className="text-sm text-[var(--color-muted)]">No teammates yet.</p>
          ) : (
            <ul className="space-y-2">
              {members.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  viewer={viewer}
                  onChangeRole={handleChangeRole}
                  onRemove={(target) => {
                    setRemoveTarget(target);
                  }}
                  pending={pending}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {viewer !== null && (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          viewer={viewer}
          onInvited={async () => {
            await mutate();
          }}
        />
      )}

      {/* Remove confirm (step 1, confirm intent) */}
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setRemoveTarget(null);
        }}
        title="Remove teammate?"
        description={
          removeTarget === null
            ? ''
            : `${removeTarget.email} will be locked out immediately. Their audit history stays intact. You can re-invite them later.`
        }
        confirmLabel="Remove"
        variant="destructive"
        loading={pending}
        onConfirm={handleRemoveConfirmClick}
      />

      {/* Remove reauth (step 2, password + TOTP) */}
      <DestructiveReauthModal
        open={removeTargetReauth !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTargetReauth(null);
        }}
        audience="firm"
        destructive
        title="Remove teammate"
        description={
          removeTargetReauth === null
            ? ''
            : `Removing ${removeTargetReauth.email} locks their account and burns any open invites. Confirm with your password and authenticator code.`
        }
        confirmLabel="Remove teammate"
        onConfirm={handleRemoveConfirmed}
      />

      {/* Role change reauth */}
      <DestructiveReauthModal
        open={roleChangeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRoleChangeTarget(null);
        }}
        audience="firm"
        title="Change teammate role"
        description={
          roleChangeTarget === null
            ? ''
            : `Promoting or demoting ${roleChangeTarget.member.email} to ${roleLabel(roleChangeTarget.newRole)} updates their permissions firm-wide. Confirm with your password and authenticator code.`
        }
        confirmLabel="Change role"
        onConfirm={handleRoleChangeConfirmed}
      />
    </div>
  );
}
