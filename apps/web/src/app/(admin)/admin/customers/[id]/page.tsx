'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Shield,
  ShieldAlert,
  ShieldOff,
  Lock,
  Unlock,
  Ban,
  RotateCcw,
  Phone,
  Mail,
  Fingerprint,
  AlertTriangle,
  Ticket as TicketIcon,
  Award,
  UserCog,
} from 'lucide-react';
import useSWR from 'swr';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StatusBadge } from '@/components/shared/status-badge';
import {
  type BadgeVariant,
  CREDENTIAL_LEVEL_BADGE_MAP,
  KYC_LEVEL_BADGE_MAP,
  scoreVariant,
} from '@/lib/kyc/display';
import { RelativeTime } from '@/components/shared/relative-time';
import { EmptyState } from '@/components/shared/empty-state';
import { UserAvatar } from '@/components/shared/user-avatar';
import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';
import { PageHeader } from '@/components/shared/page-header';
import { ChainTxLink } from '@/components/shared/chain-tx-link';
import { toast } from 'sonner';
import {
  useAdminCustomerDetail,
  useAdminCustomerAction,
  type AdminKycSession,
  type AdminCredential,
  type AdminCustomerTicket,
  type AdminCustomerRole,
} from '@/hooks/use-admin-customers';
import { useAdminPermissions } from '@/hooks/use-admin-permissions';
import { resolveSessionStatusDisplay } from '@/lib/kyc/session-status-display';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Constants & Mappings                                                      */
/* -------------------------------------------------------------------------- */

const STATUS_BADGE_MAP: Record<string, { variant: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; label: string }> = {
  active: { variant: 'success', label: 'Active' },
  pending_verification: { variant: 'info', label: 'Pending' },
  suspended: { variant: 'warning', label: 'Suspended' },
  locked: { variant: 'warning', label: 'Locked' },
  banned: { variant: 'danger', label: 'Banned' },
};

const CREDENTIAL_STATUS_MAP: Record<string, { variant: BadgeVariant; label: string }> = {
  active: { variant: 'success', label: 'Active' },
  revoked: { variant: 'danger', label: 'Revoked' },
  // Archived after a higher-level credential supersedes this one
  // (e.g. basic → enhanced via address verification). The row is no
  // longer the active credential for the user, so render it as a
  // muted/neutral state, green would imply "still good", which it
  // isn't.
  superseded: { variant: 'neutral', label: 'Archived' },
  expired: { variant: 'warning', label: 'Expired' },
};

// KYC session status display rows are sourced from
// `lib/kyc/session-status-display.ts` (shared with the customer
// dashboard, /kyc page, and any other surface). The earlier inline
// map listed legacy `completed` / `failed` keys that never existed in
// `kyc_session_status` and skipped six current statuses
// (`in_review`, `identity_approved`, `address_in_progress`,
// `revoked`, `resubmission_pending`, `kyc_expired`), admin would
// see raw enum strings for any of those rows. Centralised now so a
// future enum addition fans out to every screen automatically.

interface ActionConfig {
  readonly action: string;
  readonly label: string;
  readonly description: string;
  readonly variant: 'default' | 'destructive';
  readonly icon: React.ReactNode;
  readonly requiresReason: boolean;
  /**
   * Permission predicate. Called with the caller's `hasPermission`
   * helper; returning `false` hides the action from the menu.
   * When `undefined`, the action is always visible (no RBAC gate).
   */
  readonly permissionCheck?: (has: (code: string) => boolean) => boolean;
}

function getAvailableActions(
  status: string,
  hasPermission: (code: string) => boolean,
  adminRole: string,
): readonly ActionConfig[] {
  const actions: ActionConfig[] = [];

  if (status === 'active') {
    actions.push({
      action: 'suspend',
      label: 'Suspend Account',
      description: 'Temporarily suspend this customer account. The customer will not be able to log in or use services.',
      variant: 'destructive',
      icon: <ShieldAlert className="h-4 w-4" aria-hidden="true" />,
      requiresReason: true,
      permissionCheck: (has) => has('admin.customer.ban'),
    });
    actions.push({
      action: 'lock',
      label: 'Lock Account',
      description: 'Lock this customer account. This prevents all access until manually unlocked.',
      variant: 'destructive',
      icon: <Lock className="h-4 w-4" aria-hidden="true" />,
      requiresReason: true,
      permissionCheck: (has) => has('admin.customer.ban'),
    });
    actions.push({
      action: 'ban',
      label: 'Ban Account',
      description: 'Permanently ban this customer. This is a severe action and should be used for policy violations.',
      variant: 'destructive',
      icon: <Ban className="h-4 w-4" aria-hidden="true" />,
      requiresReason: true,
      // Matrix: Admin+ can ban (reversible via dedicated unban endpoint).
      permissionCheck: (has) => has('admin.customer.ban'),
    });
  }

  if (status === 'suspended') {
    actions.push({
      action: 'activate',
      label: 'Reactivate Account',
      description: 'Reactivate this suspended account. The customer will regain full access.',
      variant: 'default',
      icon: <Shield className="h-4 w-4" aria-hidden="true" />,
      requiresReason: false,
      permissionCheck: (has) => has('admin.customer.ban'),
    });
  }

  if (status === 'locked') {
    actions.push({
      action: 'unlock',
      label: 'Unlock Account',
      description: 'Unlock this account and reset failed login attempts. The customer will be able to log in again.',
      variant: 'default',
      icon: <Unlock className="h-4 w-4" aria-hidden="true" />,
      requiresReason: false,
      permissionCheck: (has) => has('admin.customer.ban'),
    });
  }

  if (status === 'banned') {
    actions.push({
      action: 'activate',
      label: 'Unban Account',
      description: 'Remove the ban and reactivate this account. The customer will regain full access.',
      variant: 'default',
      icon: <ShieldOff className="h-4 w-4" aria-hidden="true" />,
      requiresReason: false,
      // Unban via PATCH, handler's Superadmin-only guard is the
      // authoritative check because the PATCH endpoint's middleware
      // permission (`admin.customer.ban`) is less strict. Gate UI on
      // the dedicated unban permission so only Superadmin sees it.
      permissionCheck: (has) => has('admin.customer.unban'),
    });
  }

  // Reset KYC, handler enforces Superadmin (no dedicated permission
  // code; the route's middleware uses `admin.customer.ban`). Gate UI
  // on the role string until a `admin.customer.reset_kyc` permission
  // is carved out.
  actions.push({
    action: 'reset_kyc',
    label: 'Reset KYC',
    description: 'Reset all KYC verification data for this customer. They will need to complete verification again. This action cannot be undone.',
    variant: 'destructive',
    icon: <RotateCcw className="h-4 w-4" aria-hidden="true" />,
    requiresReason: true,
    permissionCheck: () => adminRole === 'superadmin',
  });

  return actions.filter((a) => {
    if (a.permissionCheck === undefined) return true;
    return a.permissionCheck(hasPermission);
  });
}

/* -------------------------------------------------------------------------- */
/*  Reusable badge helpers                                                    */
/* -------------------------------------------------------------------------- */

function CustomerStatusBadge({ status }: { readonly status: string }) {
  const mapping = STATUS_BADGE_MAP[status];
  if (!mapping) {
    return <StatusBadge status="neutral">{status}</StatusBadge>;
  }
  return <StatusBadge status={mapping.variant}>{mapping.label}</StatusBadge>;
}

function CustomerKycBadge({ level }: { readonly level: string }) {
  const mapping = KYC_LEVEL_BADGE_MAP[level];
  if (!mapping) {
    return <StatusBadge status="neutral" dot={false}>{level}</StatusBadge>;
  }
  return <StatusBadge status={mapping.variant} dot={false}>{mapping.label}</StatusBadge>;
}

function CustomerScoreBadge({ score }: { readonly score: number }) {
  return (
    <StatusBadge status={scoreVariant(score)} dot={false}>
      Score: {score}
    </StatusBadge>
  );
}

/* -------------------------------------------------------------------------- */
/*  Loading skeleton                                                          */
/* -------------------------------------------------------------------------- */

function AdminCustomerDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Skeleton className="h-72" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-32" />
        </div>
        <div className="space-y-6">
          <Skeleton className="h-64" />
          <Skeleton className="h-40" />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Info row helper                                                           */
/* -------------------------------------------------------------------------- */

interface InfoRowProps {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: React.ReactNode;
}

function InfoRow({ icon, label, value }: InfoRowProps) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="mt-0.5 shrink-0 text-[var(--color-muted)]">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-[var(--color-muted)]">{label}</p>
        <p className="mt-0.5 text-[var(--color-fg)] break-words">{value}</p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section helpers, split active rows into a top block and archive          */
/*  rows into a fixed-height scrollable block (max ~3 cards visible).          */
/* -------------------------------------------------------------------------- */

/**
 * Theme scrollbar classes, same recipe used by docs sidebar so the
 * track / thumb pick up the project's `--color-border` / surface
 * tokens. Centralised here to keep the two split-list blocks below in
 * lock-step (and so a future theme tweak edits one place).
 */
const ARCHIVE_SCROLL_CLASSES =
  'scrollbar-thin scrollbar-thumb-[var(--color-border)] scrollbar-track-transparent max-h-[18rem] overflow-y-auto pr-1';

/**
 * Sub-header used to label each block within a section ("Active" /
 * "Archived"). Subtle uppercase to keep the visual weight on the row
 * cards themselves.
 */
function GroupHeader({ label, count }: { readonly label: string; readonly count: number }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
      <span>{label}</span>
      <span className="text-[var(--color-muted)]/60">({count})</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  KYC Sessions section                                                      */
/* -------------------------------------------------------------------------- */

/**
 * "Approved" sessions are pinned to the top in their own block; every
 * other status (in-flight, expired, revoked, rejected, …) goes below
 * in a scrollable archive block, at the request of the admin team a
 * customer with one approved address session and a long tail of older
 * resets shouldn't make the user scroll past noise to find the row
 * that mattered.
 */
function KycSessionsSection({ sessions }: { readonly sessions: readonly AdminKycSession[] }) {
  if (sessions.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">KYC Sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={<Fingerprint className="h-5 w-5" aria-hidden="true" />}
            title="No KYC sessions"
            description="This customer has not started any KYC verification."
            className="py-6"
          />
        </CardContent>
      </Card>
    );
  }

  const approved = sessions.filter((s) => s.status === 'approved');
  const archived = sessions.filter((s) => s.status !== 'approved');

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">KYC Sessions ({sessions.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {approved.length > 0 && (
          <div>
            <GroupHeader label="Approved" count={approved.length} />
            <div className="space-y-3">
              {approved.map((session) => (
                <KycSessionCard key={session.id} session={session} />
              ))}
            </div>
          </div>
        )}
        {archived.length > 0 && (
          <div>
            <GroupHeader label="Archived" count={archived.length} />
            <div className={cn(ARCHIVE_SCROLL_CLASSES, 'space-y-3')}>
              {archived.map((session) => (
                <KycSessionCard key={session.id} session={session} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function KycSessionCard({ session }: { readonly session: AdminKycSession }) {
  const statusDisplay = resolveSessionStatusDisplay(session.status);
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={statusDisplay.variant} dot={false}>
          {statusDisplay.adminLabel}
        </StatusBadge>
        <span className="text-xs font-medium text-[var(--color-fg)]">
          {session.workflowType === 'phase1'
            ? 'Phase 1 (Identity)'
            : session.workflowType === 'phase2'
              ? 'Phase 2 (Address)'
              : session.workflowType}
        </span>
      </div>
      {session.diditSessionId && (
        <p className="mt-1.5 font-mono text-xs text-[var(--color-muted)] break-all">
          Didit: {session.diditSessionId}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
        <span>Created: <RelativeTime date={session.createdAt} /></span>
        <span>Updated: <RelativeTime date={session.updatedAt} /></span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Credentials & NFTs section                                                */
/* -------------------------------------------------------------------------- */

/**
 * A row is "active" when the credential itself is `status='active'`
 * AND has not been superseded or revoked. Anything else (replaced /
 * revoked / expired) drops to the archive block. Each row also
 * surfaces the optional NFT artefact derived from the same row's
 * `nftContractId` / `nftMintedAt` / `nftBurnedAt` fields, a single
 * card represents the full on-chain footprint of that credential
 * issuance.
 */
function CredentialsSection({ credentials }: { readonly credentials: readonly AdminCredential[] }) {
  if (credentials.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Credentials &amp; NFTs</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={<Award className="h-5 w-5" aria-hidden="true" />}
            title="No credentials"
            description="This customer has no issued credentials."
            className="py-6"
          />
        </CardContent>
      </Card>
    );
  }

  const active = credentials.filter(
    (c) => c.status === 'active' && c.supersededBy === null && c.revokedAt === null,
  );
  const archived = credentials.filter(
    (c) => !(c.status === 'active' && c.supersededBy === null && c.revokedAt === null),
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Credentials &amp; NFTs ({credentials.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {active.length > 0 && (
          <div>
            <GroupHeader label="Active" count={active.length} />
            <div className="space-y-3">
              {active.map((cred) => (
                <CredentialCard key={cred.id} cred={cred} />
              ))}
            </div>
          </div>
        )}
        {archived.length > 0 && (
          <div>
            <GroupHeader label="Archived" count={archived.length} />
            <div className={cn(ARCHIVE_SCROLL_CLASSES, 'space-y-3')}>
              {archived.map((cred) => (
                <CredentialCard key={cred.id} cred={cred} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CredentialCard({ cred }: { readonly cred: AdminCredential }) {
  const levelMapping = CREDENTIAL_LEVEL_BADGE_MAP[cred.level];
  const statusMapping = CREDENTIAL_STATUS_MAP[cred.status];

  // Phrase the credential type the way the dashboard talks about it
  // ("basic credential tx", "enhanced credential tx") so the operator
  // sees the same words across the admin + customer + dashboard
  // surfaces.
  const credentialTxLabel = `${cred.level} credential tx`;

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={statusMapping?.variant ?? 'neutral'}>
          {statusMapping?.label ?? cred.status}
        </StatusBadge>
        <StatusBadge status={levelMapping?.variant ?? 'neutral'} dot={false}>
          {levelMapping?.label ?? cred.level}
        </StatusBadge>
      </div>

      {cred.chainContractId !== null && (
        <div className="mt-3">
          <ChainTxLink
            updateId={cred.chainUpdateId}
            displayId={cred.chainContractId}
            network={cred.chainNetwork}
            label={credentialTxLabel}
          />
        </div>
      )}
      {cred.nftContractId !== null && (
        <div className="mt-3">
          <ChainTxLink
            updateId={cred.nftChainUpdateId}
            displayId={cred.nftContractId}
            network={cred.chainNetwork}
            label="NFT credential"
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
        <span>Issued: <RelativeTime date={cred.createdAt} /></span>
        {cred.nftMintedAt !== null && cred.nftBurnedAt === null && (
          <span>NFT minted: <RelativeTime date={cred.nftMintedAt} /></span>
        )}
        {cred.nftBurnedAt !== null && (
          <span>NFT burned: <RelativeTime date={cred.nftBurnedAt} /></span>
        )}
        {cred.revokedAt !== null && (
          <span>
            Revoked: <RelativeTime date={cred.revokedAt} />
            {cred.revokedReason !== null && (
              <span className="ml-1 text-[var(--color-muted)]/70">({cred.revokedReason})</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Recent Tickets section                                                    */
/* -------------------------------------------------------------------------- */

function RecentTicketsSection({ tickets }: { readonly tickets: readonly AdminCustomerTicket[] }) {
  if (tickets.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Recent Tickets</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={<TicketIcon className="h-5 w-5" aria-hidden="true" />}
            title="No tickets"
            description="This customer has not created any support tickets."
            className="py-6"
          />
        </CardContent>
      </Card>
    );
  }

  const TICKET_STATUS_MAP: Record<string, { variant: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; label: string }> = {
    open: { variant: 'info', label: 'Open' },
    in_progress: { variant: 'warning', label: 'In Progress' },
    waiting_customer: { variant: 'neutral', label: 'Waiting' },
    resolved: { variant: 'success', label: 'Resolved' },
    closed: { variant: 'neutral', label: 'Closed' },
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Recent Tickets ({tickets.length})</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {tickets.map((ticket) => {
            const statusMapping = TICKET_STATUS_MAP[ticket.status];
            return (
              <Link
                key={ticket.id}
                href={`/admin/tickets/${ticket.id}`}
                className="block rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 transition-colors hover:bg-[var(--color-surface)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="font-mono text-xs text-[var(--color-muted)]">
                      {ticket.referenceNumber}
                    </span>
                    <p className="mt-0.5 truncate text-sm font-medium text-[var(--color-fg)]">
                      {ticket.subject}
                    </p>
                  </div>
                  <StatusBadge
                    status={statusMapping?.variant ?? 'neutral'}
                    dot={false}
                  >
                    {statusMapping?.label ?? ticket.status}
                  </StatusBadge>
                </div>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  <RelativeTime date={ticket.createdAt} />
                </p>
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Action dialog                                                             */
/* -------------------------------------------------------------------------- */

interface ActionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly config: ActionConfig | null;
  readonly customerId: string;
  readonly onSuccess: () => void;
}

function ActionDialog({ open, onOpenChange, config, customerId, onSuccess }: ActionDialogProps) {
  const [reason, setReason] = React.useState('');
  // BUG #58: chained reauth modal, collected after the admin
  // confirms the action+reason form so customer-status mutations
  // (suspend/lock/ban/unban/activate/reset_kyc) carry password+TOTP.
  const [showReauth, setShowReauth] = React.useState(false);
  const { execute } = useAdminCustomerAction();

  // Reset reason when dialog opens/closes
  React.useEffect(() => {
    if (!open) {
      setReason('');
    }
  }, [open]);

  if (!config) return null;

  function handleConfirmClick() {
    if (config?.action === 'reset_kyc' && reason.trim() === '') {
      // Defence-in-depth: button is disabled but in case of edge case
      // (browser autofill, race) bail out before the reauth prompt.
      return;
    }
    setShowReauth(true);
  }

  async function handleConfirmReauthed({
    currentPassword,
    totpCode,
  }: { currentPassword: string; totpCode: string }) {
    if (!config) return;
    const res = await execute(
      customerId,
      config.action,
      config.requiresReason ? reason : undefined,
      { currentPassword, totpCode },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = body['error'] as Record<string, unknown> | undefined;
      throw new Error(
        (err?.['message'] as string | undefined) ?? `Failed to ${config.label.toLowerCase()}.`,
      );
    }
    toast.success(`${config.label} completed successfully.`);
    onOpenChange(false);
    onSuccess();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{config.label}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>

        {config.requiresReason && (
          <div className="space-y-2">
            <label
              htmlFor="action-reason"
              className="text-sm font-medium text-[var(--color-fg)]"
            >
              Reason {config.action === 'reset_kyc' ? '(required)' : '(optional)'}
            </label>
            <Textarea
              id="action-reason"
              value={reason}
              onChange={(e) => { setReason(e.target.value); }}
              placeholder="Provide a reason for this action..."
              rows={3}
            />
          </div>
        )}

        {config.action === 'reset_kyc' && (
          <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 p-3">
            <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--color-warning)]" aria-hidden="true" />
            <p className="text-xs text-[var(--color-warning)]">
              This will permanently delete all KYC verification data. The customer will need to re-verify from scratch. This action cannot be undone.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => { onOpenChange(false); }}
          >
            Cancel
          </Button>
          <Button
            variant={config.variant === 'destructive' ? 'destructive' : 'default'}
            onClick={handleConfirmClick}
            disabled={config.action === 'reset_kyc' && reason.trim() === ''}
          >
            {config.icon}
            {config.label}
          </Button>
        </DialogFooter>
      </DialogContent>
      <DestructiveReauthModal
        open={showReauth}
        onOpenChange={setShowReauth}
        audience="admin"
        title={`Confirm: ${config.label}`}
        description={`Re-authenticate to ${config.label.toLowerCase()}. ${config.description}`}
        confirmLabel={config.label}
        destructive={config.variant === 'destructive'}
        onConfirm={handleConfirmReauthed}
      />
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  Quick Actions card                                                        */
/* -------------------------------------------------------------------------- */

interface QuickActionsCardProps {
  readonly status: string;
  readonly customerId: string;
  readonly adminRole: string;
  readonly onActionComplete: () => void;
}

function QuickActionsCard({ status, customerId, adminRole, onActionComplete }: QuickActionsCardProps) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [selectedAction, setSelectedAction] = React.useState<ActionConfig | null>(null);

  const { has: hasAdminPermission } = useAdminPermissions();
  const actions = getAvailableActions(status, hasAdminPermission, adminRole);

  function openActionDialog(config: ActionConfig) {
    setSelectedAction(config);
    setDialogOpen(true);
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {actions.map((actionConfig) => (
            <Button
              key={actionConfig.action}
              variant="outline"
              size="sm"
              className={cn(
                'w-full justify-start',
                actionConfig.variant === 'destructive' && 'border-[var(--color-danger)]/30 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 hover:text-[var(--color-danger)]',
              )}
              onClick={() => { openActionDialog(actionConfig); }}
            >
              {actionConfig.icon}
              {actionConfig.label}
            </Button>
          ))}
        </CardContent>
      </Card>

      <ActionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        config={selectedAction}
        customerId={customerId}
        onSuccess={onActionComplete}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Roles card                                                                */
/* -------------------------------------------------------------------------- */

function RolesCard({ roles }: { readonly roles: readonly AdminCustomerRole[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Roles</CardTitle>
      </CardHeader>
      <CardContent>
        {roles.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">No roles assigned.</p>
        ) : (
          <div className="space-y-2">
            {roles.map((role) => (
              <div
                key={role.id}
                className="flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium text-[var(--color-fg)]">{role.displayName}</p>
                  <p className="text-xs text-[var(--color-muted)]">{role.name}</p>
                </div>
                <div className="flex gap-1">
                  {role.isSystem && (
                    <StatusBadge status="info" dot={false}>System</StatusBadge>
                  )}
                  {role.isPreset && (
                    <StatusBadge status="neutral" dot={false}>Preset</StatusBadge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <Separator className="my-3" />
        <Link
          href="/admin/rbac"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] rounded-[var(--radius-sm)]"
        >
          <UserCog className="h-3.5 w-3.5" aria-hidden="true" />
          Manage Roles
        </Link>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Customer profile card                                                     */
/* -------------------------------------------------------------------------- */

function CustomerProfileCard({
  customer,
}: {
  readonly customer: NonNullable<ReturnType<typeof useAdminCustomerDetail>['detail']>['customer'];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start gap-4">
          <UserAvatar
            user={{
              id: customer.id,
              displayName: customer.displayName,
              avatarUrl: customer.avatarUrl,
            }}
            size="xl"
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold text-[var(--color-fg)]">
              {customer.displayName ?? customer.email ?? 'Wallet User'}
            </h2>
            {customer.displayName && customer.email !== null && (
              <p className="truncate text-sm text-[var(--color-muted)]">{customer.email}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <CustomerStatusBadge status={customer.status} />
              <CustomerKycBadge level={customer.kycLevel} />
              <CustomerScoreBadge score={customer.kycScore} />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Contact info */}
        <div className="space-y-3">
          <InfoRow
            icon={<Mail className="h-4 w-4" aria-hidden="true" />}
            label="Email"
            value={
              customer.email !== null ? (
                <span>
                  {customer.email}
                  {customer.emailVerifiedAt && (
                    <span className="ml-2 text-xs text-[var(--color-success)]">Verified</span>
                  )}
                </span>
              ) : (
                <span className="italic text-[var(--color-muted)]/60">Not set</span>
              )
            }
          />
          {customer.phone && (
            <InfoRow
              icon={<Phone className="h-4 w-4" aria-hidden="true" />}
              label="Phone"
              value={customer.phone}
            />
          )}
        </div>

        {/*
          Identity + address sections deliberately removed. Crivacy
          stores ZERO raw PII columns post migration 20260509000000 —
          the customer's name / DOB / address / document fields live
          exclusively in Didit. Operators who need PII context open the
          Didit dashboard via the deep-link surfaced in the
          KycSessionsCard below (each session row links out to its
          Didit session detail page). Doctrine: non-custodial
          verification, see .claude/PII-PURGE-AND-COMPOSITE-HASH.md.
        */}

        {/* Account dates */}
        <Separator />
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
            Account
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="text-sm">
              <p className="text-xs text-[var(--color-muted)]">Joined</p>
              <RelativeTime date={customer.createdAt} className="text-[var(--color-fg)]" />
            </div>
            <div className="text-sm">
              <p className="text-xs text-[var(--color-muted)]">Email Verified</p>
              {customer.emailVerifiedAt ? (
                <RelativeTime date={customer.emailVerifiedAt} className="text-[var(--color-fg)]" />
              ) : customer.email !== null ? (
                <span className="italic text-[var(--color-muted)]/60">Not verified</span>
              ) : (
                <span className="italic text-[var(--color-muted)]/60">No email</span>
              )}
            </div>
            <div className="text-sm">
              <p className="text-xs text-[var(--color-muted)]">Last Login</p>
              {customer.lastLoginAt ? (
                <RelativeTime date={customer.lastLoginAt} className="text-[var(--color-fg)]" />
              ) : (
                <span className="italic text-[var(--color-muted)]/60">Never</span>
              )}
            </div>
            <div className="text-sm">
              <p className="text-xs text-[var(--color-muted)]">Last Updated</p>
              <RelativeTime date={customer.updatedAt} className="text-[var(--color-fg)]" />
            </div>
          </div>
        </div>

        {/* Lock info */}
        {(customer.lockedAt || customer.lockReason || customer.failedLoginAttempts > 0) && (
          <>
            <Separator />
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-warning)]">
                Lock Information
              </p>
              <div className="rounded-[var(--radius-md)] border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 p-3 space-y-2">
                {customer.lockedAt && (
                  <div className="text-sm">
                    <span className="text-xs text-[var(--color-muted)]">Locked at: </span>
                    <RelativeTime date={customer.lockedAt} className="text-[var(--color-fg)]" />
                  </div>
                )}
                {customer.lockReason && (
                  <div className="text-sm">
                    <span className="text-xs text-[var(--color-muted)]">Reason: </span>
                    <span className="text-[var(--color-fg)]">{customer.lockReason}</span>
                  </div>
                )}
                {customer.failedLoginAttempts > 0 && (
                  <div className="text-sm">
                    <span className="text-xs text-[var(--color-muted)]">Failed login attempts: </span>
                    <span className="font-medium text-[var(--color-warning)]">{customer.failedLoginAttempts}</span>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Admin customer detail page.
 *
 * Layout:
 * - Left column (2/3): Customer profile card (avatar, contact, identity,
 *   address, account dates, lock info), KYC sessions, credentials, recent tickets.
 * - Right column (1/3): Quick actions card (context-dependent action buttons
 *   with confirmation dialogs), roles card.
 */
export default function AdminCustomerDetailPage() {
  const params = useParams();
  const rawId = params?.['id'];
  const customerId = typeof rawId === 'string' ? rawId : null;
  const { detail, error, isLoading, mutate } = useAdminCustomerDetail(customerId);
  const { data: adminMe } = useSWR<{ role: string }>('/api/internal/admin/me');
  const adminRole = adminMe?.role ?? 'support';

  if (isLoading) {
    return <AdminCustomerDetailSkeleton />;
  }

  if (error || !detail) {
    const status = (error as { status?: number } | undefined)?.status;
    return (
      <div className="space-y-6">
        <Link
          href="/admin/customers"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] rounded-[var(--radius-sm)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Customers
        </Link>
        <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-4">
          <p className="text-sm text-[var(--color-danger)]">
            {status === 404
              ? 'Customer not found.'
              : 'Failed to load customer. Please try again.'}
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

  const { customer, kycSessions, credentials, recentTickets, roles } = detail;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/admin/customers"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] rounded-[var(--radius-sm)]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to Customers
      </Link>

      {/* Page header */}
      <PageHeader
        title={customer.displayName ?? customer.email ?? 'Wallet User'}
        breadcrumbs={[
          { label: 'Customers', href: '/admin/customers' },
          { label: customer.displayName ?? customer.email ?? 'Wallet User' },
        ]}
      />

      {/* Two-column layout */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left column: profile + sections */}
        <div className="space-y-6 lg:col-span-2">
          <CustomerProfileCard customer={customer} />
          <KycSessionsSection sessions={kycSessions} />
          <CredentialsSection credentials={credentials} />
          <RecentTicketsSection tickets={recentTickets} />
        </div>

        {/* Right column: actions + roles */}
        <div className="space-y-6">
          <QuickActionsCard
            status={customer.status}
            customerId={customer.id}
            adminRole={adminRole}
            onActionComplete={() => { void mutate(); }}
          />
          <RolesCard roles={roles} />
        </div>
      </div>
    </div>
  );
}
