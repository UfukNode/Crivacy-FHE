'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { PageHeader } from '@/components/shared/page-header';
import { SearchInput } from '@/components/shared/search-input';
import { EmptyState } from '@/components/shared/empty-state';
import { Pagination } from '@/components/shared/pagination';
import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';
import { COUNTRIES } from '@/lib/countries';
import { slugify } from '@/lib/slugify';
import { useAdminPermissions } from '@/hooks/use-admin-permissions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FirmRow {
  id: string;
  name: string;
  slug: string;
  tier: string;
  contactEmail: string;
  countryCode: string | null;
  createdAt: string;
  deletedAt: string | null;
}

interface FirmsResponse {
  firms: FirmRow[];
  total: number;
}

const TIERS = ['free', 'starter', 'pro', 'enterprise'] as const;

const TIER_VARIANT: Record<string, 'secondary' | 'default' | 'success' | 'warning'> = {
  free: 'secondary',
  starter: 'default',
  pro: 'success',
  enterprise: 'warning',
};

// ---------------------------------------------------------------------------
// Cookie-based mutation helper (reads use the SWR fetcher from layout)
// ---------------------------------------------------------------------------

async function adminMutate(path: string, init: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Error-response helpers
// ---------------------------------------------------------------------------

/**
 * Turn the label `ownerEmail` into `Owner Email` for the toast, so the
 * user sees the same words they just read next to the input. Matches
 * the Zod path segments emitted by `mapZodError` (the route module
 * uses camelCase fields so the conversion covers every create/edit
 * surface this page posts to).
 */
function humanizePath(path: string): string {
  if (path.length === 0) return '';
  return path
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

interface ApiErrorShape {
  error?: {
    message?: string;
    details?: {
      issues?: Array<{ path?: string; message?: string }>;
    };
  };
}

/**
 * Prefer the first `details.issues[]` entry (field-level Zod message)
 * over the generic envelope `error.message`, the latter is the
 * schema-mismatch string which tells the user nothing about *which*
 * field failed.
 */
function extractFormError(body: ApiErrorShape, fallback: string): string {
  const issue = body.error?.details?.issues?.[0];
  if (issue !== undefined && typeof issue.message === 'string') {
    const label = typeof issue.path === 'string' && issue.path.length > 0 ? humanizePath(issue.path) : '';
    return label.length > 0 ? `${label}: ${issue.message}` : issue.message;
  }
  return body.error?.message ?? fallback;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminFirmsPage() {
  // Per-action permission gates (server-side middleware already
  // enforces; these hide buttons the caller cannot execute).
  const { has: hasAdminPermission } = useAdminPermissions();
  const canCreate = hasAdminPermission('admin.firm.create');
  const canUpdate = hasAdminPermission('admin.firm.update');
  const canSuspend = hasAdminPermission('admin.firm.suspend');

  // Filters
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState('all');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [page, setPage] = useState(1);

  // Dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [editFirm, setEditFirm] = useState<FirmRow | null>(null);
  const [deleteFirm, setDeleteFirm] = useState<FirmRow | null>(null);

  // BUG #58: destructive reauth gate (password + TOTP), opened
  // *after* the form dialog so the admin re-authenticates before the
  // firm record is touched. The form dialog stays open behind the
  // reauth modal so a cancelled reauth keeps the entered values.
  // Delete uses a single combined modal (description names the firm).
  const [showCreateReauth, setShowCreateReauth] = useState(false);
  const [showEditReauth, setShowEditReauth] = useState(false);

  // Form fields
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  // `slugTouched` flips true the first time the admin manually types
  // into the slug input. Until then the slug re-derives from the
  // name on every keystroke (Stripe / Vercel create-form pattern).
  // Once the user overrides, we stop tracking the name so a trailing
  // correction doesn't wipe their custom slug.
  const [slugTouched, setSlugTouched] = useState(false);
  const [formTier, setFormTier] = useState<string>('free');
  const [formEmail, setFormEmail] = useState('');
  const [formCountry, setFormCountry] = useState('');
  // Dashboard-owner email, only used on create. On edit we don't
  // surface this because the firm may already have live users; owner
  // administration goes through a dedicated users page later.
  const [formOwnerEmail, setFormOwnerEmail] = useState('');

  const handleNameChange = useCallback(
    (next: string) => {
      setFormName(next);
      if (!slugTouched) {
        setFormSlug(slugify(next));
      }
    },
    [slugTouched],
  );

  const handleSlugChange = useCallback((next: string) => {
    setSlugTouched(true);
    // Still sanitise what the user types so we never ship an invalid
    // slug to the API, spaces become hyphens, uppercase folds down,
    // non-alphanumerics are stripped.
    setFormSlug(slugify(next));
  }, []);

  // Build query string for SWR
  const buildUrl = useCallback(() => {
    const qs = new URLSearchParams();
    qs.set('limit', String(PAGE_SIZE));
    qs.set('offset', String((page - 1) * PAGE_SIZE));
    if (includeDeleted) qs.set('includeDeleted', 'true');
    if (search.length > 0) qs.set('search', search);
    if (tierFilter !== 'all') qs.set('tier', tierFilter);
    return `/api/internal/admin/firms?${qs.toString()}`;
  }, [page, includeDeleted, search, tierFilter]);

  const { data, error, isLoading, mutate } = useSWR<FirmsResponse>(buildUrl());

  const firms = data?.firms ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Reset page on filter change
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const handleTierFilterChange = useCallback((value: string) => {
    setTierFilter(value);
    setPage(1);
  }, []);

  // Open create dialog
  const openCreate = useCallback(() => {
    setFormName('');
    setFormSlug('');
    setSlugTouched(false);
    setFormTier('free');
    setFormEmail('');
    setFormCountry('');
    setFormOwnerEmail('');
    setCreateOpen(true);
  }, []);

  // Open edit dialog. Existing firms already have a slug so the
  // slug field stops tracking the name, if the admin renames the
  // firm we preserve the original slug (URLs stay stable).
  const openEdit = useCallback((firm: FirmRow) => {
    setFormName(firm.name);
    setFormSlug(firm.slug);
    setSlugTouched(true);
    setFormTier(firm.tier);
    setFormEmail(firm.contactEmail);
    setFormCountry(firm.countryCode ?? '');
    setEditFirm(firm);
  }, []);

  // Create firm, runs after reauth modal verifies envelope. Throws
  // on backend rejection so the modal renders the message inline and
  // stays open for retry.
  const handleCreateConfirmed = useCallback(
    async ({ currentPassword, totpCode }: { currentPassword: string; totpCode: string }) => {
      const res = await adminMutate('/api/internal/admin/firms', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword,
          totpCode,
          name: formName,
          slug: formSlug,
          tier: formTier,
          contactEmail: formEmail,
          ownerEmail: formOwnerEmail,
          ...(formCountry.length === 2 ? { countryCode: formCountry } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorShape;
        throw new Error(extractFormError(body, 'Failed to create firm.'));
      }
      toast.success(`Firm created. Invite sent to ${formOwnerEmail}.`);
      setCreateOpen(false);
      void mutate();
    },
    [formName, formSlug, formTier, formEmail, formCountry, formOwnerEmail, mutate],
  );

  // Update firm, same envelope-on-success pattern.
  const handleUpdateConfirmed = useCallback(
    async ({ currentPassword, totpCode }: { currentPassword: string; totpCode: string }) => {
      if (editFirm === null) return;
      const res = await adminMutate(`/api/internal/admin/firms/${editFirm.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          currentPassword,
          totpCode,
          name: formName,
          slug: formSlug,
          tier: formTier,
          contactEmail: formEmail,
          ...(formCountry.length === 2 ? { countryCode: formCountry } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorShape;
        throw new Error(extractFormError(body, 'Failed to update firm.'));
      }
      toast.success('Firm updated successfully.');
      setEditFirm(null);
      void mutate();
    },
    [editFirm, formName, formSlug, formTier, formEmail, formCountry, mutate],
  );

  // Delete firm, DELETE bodies are accepted by Next route handlers.
  const handleDeleteConfirmed = useCallback(
    async ({ currentPassword, totpCode }: { currentPassword: string; totpCode: string }) => {
      if (deleteFirm === null) return;
      const res = await adminMutate(`/api/internal/admin/firms/${deleteFirm.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ currentPassword, totpCode }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorShape;
        throw new Error(extractFormError(body, 'Failed to deactivate firm.'));
      }
      toast.success('Firm deactivated successfully.');
      setDeleteFirm(null);
      void mutate();
    },
    [deleteFirm, mutate],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Firm Management"
        description={`${total} firm${total !== 1 ? 's' : ''} total`}
        actions={
          canCreate ? (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Create Firm
            </Button>
          ) : null
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          value={search}
          onChange={handleSearchChange}
          placeholder="Search firms..."
          className="w-64"
        />
        <Select value={tierFilter} onValueChange={handleTierFilterChange}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All tiers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tiers</SelectItem>
            {TIERS.map((t) => (
              <SelectItem key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <Checkbox
            checked={includeDeleted}
            onCheckedChange={(checked) => {
              setIncludeDeleted(checked === true);
              setPage(1);
            }}
          />
          Show deleted
        </label>
      </div>

      {/* Error */}
      {error && !isLoading && (
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3">
          <p className="flex-1 text-sm text-[var(--color-danger)]">
            Failed to load firms.
          </p>
          <Button variant="outline" size="sm" onClick={() => void mutate()}>
            Retry
          </Button>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[var(--color-border)]">
                  <tr>
                    {['Name', 'Slug', 'Tier', 'Contact Email', 'Country', 'Created', 'Actions'].map(
                      (h) => (
                        <th key={h} scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      <td className="px-4 py-3"><Skeleton className="h-4 w-32" /></td>
                      <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                      <td className="px-4 py-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
                      <td className="px-4 py-3"><Skeleton className="h-4 w-40" /></td>
                      <td className="px-4 py-3"><Skeleton className="h-4 w-8" /></td>
                      <td className="px-4 py-3"><Skeleton className="h-4 w-20" /></td>
                      <td className="px-4 py-3"><Skeleton className="h-8 w-20" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Table */}
      {!isLoading && firms.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-[var(--color-border)]">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">Name</th>
                    <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">Slug</th>
                    <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">Tier</th>
                    <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">Contact Email</th>
                    <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">Country</th>
                    <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">Created</th>
                    <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {firms.map((firm) => (
                    <tr
                      key={firm.id}
                      className={firm.deletedAt !== null ? 'opacity-50' : ''}
                    >
                      <td className="max-w-[220px] truncate px-4 py-3 font-medium text-[var(--color-fg)]" title={firm.name}>
                        <Link
                          href={`/admin/firms/${firm.id}`}
                          className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] rounded-[var(--radius-sm)]"
                        >
                          {firm.name}
                        </Link>
                      </td>
                      <td className="max-w-[160px] truncate px-4 py-3 font-mono text-xs text-[var(--color-muted)]" title={firm.slug}>
                        {firm.slug}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={TIER_VARIANT[firm.tier] ?? 'secondary'}>
                          {firm.tier}
                        </Badge>
                      </td>
                      <td className="max-w-[240px] truncate px-4 py-3 text-[var(--color-muted)]" title={firm.contactEmail ?? ''}>
                        {firm.contactEmail}
                      </td>
                      <td className="px-4 py-3 text-[var(--color-muted)]">
                        {firm.countryCode ?? '-'}
                      </td>
                      <td className="px-4 py-3 text-[var(--color-muted)]">
                        {new Date(firm.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {canUpdate ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(firm)}
                            >
                              Edit
                            </Button>
                          ) : null}
                          {firm.deletedAt === null && canSuspend ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-[var(--color-danger)] hover:text-[var(--color-danger)]"
                              onClick={() => setDeleteFirm(firm)}
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

      {/* Empty state */}
      {!isLoading && !error && firms.length === 0 && (
        <EmptyState
          title="No firms found"
          description="Try adjusting your filters or create a new firm."
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Create Firm
            </Button>
          }
        />
      )}

      {/* Pagination */}
      {!isLoading && total > PAGE_SIZE && (
        <Pagination
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          totalItems={total}
          pageSize={PAGE_SIZE}
        />
      )}

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Firm</DialogTitle>
            <DialogDescription>Add a new firm to the platform.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="create-name">Firm Name</Label>
              <Input
                id="create-name"
                value={formName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Acme Corp"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="create-slug">Slug</Label>
              <Input
                id="create-slug"
                value={formSlug}
                onChange={(e) => handleSlugChange(e.target.value)}
                placeholder="acme-corp"
                pattern="[a-z0-9-]+"
              />
              <p className="text-xs text-[var(--color-muted)]">
                Auto-generated from the firm name. Override here if you need a
                different URL slug, it stops tracking the name as soon as you
                type.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="create-email">Contact Email</Label>
              <Input
                id="create-email"
                type="email"
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
                placeholder="contact@acme.com"
              />
            </div>
            {/* Dashboard owner, the person who will receive the
                welcome email, set the password, and enable 2FA. Only
                shown on create; post-create owner changes go through
                the firm-users flow. */}
            <div className="grid gap-2">
              <Label htmlFor="create-owner-email">Dashboard Owner Email</Label>
              <Input
                id="create-owner-email"
                type="email"
                required
                value={formOwnerEmail}
                onChange={(e) => setFormOwnerEmail(e.target.value)}
                placeholder="owner@acme.com"
              />
              <p className="text-xs text-[var(--color-muted)]">
                This address receives a single-use activation link (valid for
                72 hours). The recipient follows it to set their password,
                enroll two-factor authentication, and sign in as the firm
                owner.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Tier</Label>
                <Select value={formTier} onValueChange={setFormTier}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIERS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Country</Label>
                <Select
                  value={formCountry === '' ? '__none__' : formCountry}
                  onValueChange={(value) => setFormCountry(value === '__none__' ? '' : value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select country" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value="__none__">— None —</SelectItem>
                    {COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.name} ({c.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => setShowCreateReauth(true)}
              disabled={
                formName.length === 0
                || formSlug.length === 0
                || formEmail.length === 0
                || formOwnerEmail.length === 0
              }
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editFirm !== null} onOpenChange={(open) => { if (!open) setEditFirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Firm</DialogTitle>
            <DialogDescription>Update firm details.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-name">Firm Name</Label>
              <Input
                id="edit-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-slug">Slug</Label>
              <Input
                id="edit-slug"
                value={formSlug}
                onChange={(e) => handleSlugChange(e.target.value)}
                pattern="[a-z0-9-]+"
              />
              <p className="text-xs text-[var(--color-muted)]">
                Changing the slug updates every dashboard and API URL for this
                firm. Proceed with caution.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-email">Contact Email</Label>
              <Input
                id="edit-email"
                type="email"
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Tier</Label>
                <Select value={formTier} onValueChange={setFormTier}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIERS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Country</Label>
                <Select
                  value={formCountry === '' ? '__none__' : formCountry}
                  onValueChange={(value) => setFormCountry(value === '__none__' ? '' : value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select country" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value="__none__">— None —</SelectItem>
                    {COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.name} ({c.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditFirm(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => setShowEditReauth(true)}
              disabled={formName.length === 0 || formSlug.length === 0 || formEmail.length === 0}
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm + reauth, single modal so the admin sees the
          firm name in the description before re-authing. */}
      <DestructiveReauthModal
        open={deleteFirm !== null}
        onOpenChange={(open) => { if (!open) setDeleteFirm(null); }}
        audience="admin"
        title="Deactivate firm"
        description={`Confirm with your password and authenticator code to deactivate "${deleteFirm?.name ?? ''}". This action can be reversed later.`}
        confirmLabel="Deactivate"
        destructive
        onConfirm={handleDeleteConfirmed}
      />

      {/* Reauth modals chained behind the create / edit form dialogs.
          They close themselves on success; on failure they keep the
          form open so the admin can retry without re-typing fields. */}
      <DestructiveReauthModal
        open={showCreateReauth}
        onOpenChange={setShowCreateReauth}
        audience="admin"
        title="Confirm firm creation"
        description="Re-authenticate to provision a new firm. Owner activation email is sent on success."
        confirmLabel="Create firm"
        onConfirm={handleCreateConfirmed}
      />
      <DestructiveReauthModal
        open={showEditReauth}
        onOpenChange={setShowEditReauth}
        audience="admin"
        title="Confirm firm changes"
        description="Re-authenticate to apply the changes."
        confirmLabel="Save changes"
        onConfirm={handleUpdateConfirmed}
      />
    </div>
  );
}
