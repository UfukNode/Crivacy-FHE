'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus, Pencil, Trash2, Tags } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { DestructiveReauthModal } from '@/components/shared/destructive-reauth-modal';
import { FormField } from '@/components/shared/form-field';
import { LoadingButton } from '@/components/shared/loading-button';
import { EmptyState } from '@/components/shared/empty-state';
import {
  useAdminCategories,
  useAdminCategoryAction,
  type AdminCategory,
} from '@/hooks/use-admin-categories';
import { useAdminPermissions } from '@/hooks/use-admin-permissions';
import {
  createCategorySchema,
  updateCategorySchema,
} from '@/lib/validation/ticket';
import { cn } from '@/lib/utils';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

const AUDIENCE_OPTIONS = [
  { value: 'any', label: 'Any' },
  { value: 'customer', label: 'Customer' },
  { value: 'firm', label: 'Firm' },
] as const;

/* -------------------------------------------------------------------------- */
/*  Category form (shared between create + edit dialogs)                       */
/* -------------------------------------------------------------------------- */

interface CategoryFormData {
  name: string;
  slug: string;
  description: string;
  audience: 'customer' | 'firm' | 'any';
  icon: string;
  displayOrder: string;
}

interface CategoryFormErrors {
  name?: string;
  slug?: string;
  description?: string;
  audience?: string;
  icon?: string;
  displayOrder?: string;
}

const EMPTY_FORM: CategoryFormData = {
  name: '',
  slug: '',
  description: '',
  audience: 'any',
  icon: '',
  displayOrder: '0',
};

function categoryToForm(cat: AdminCategory): CategoryFormData {
  return {
    name: cat.name,
    slug: cat.slug,
    description: cat.description ?? '',
    audience: cat.audience,
    icon: cat.icon ?? '',
    displayOrder: String(cat.displayOrder),
  };
}

/**
 * Auto-generate slug from name: lowercase, replace spaces/special with hyphens.
 */
function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/* -------------------------------------------------------------------------- */
/*  Category form dialog                                                       */
/* -------------------------------------------------------------------------- */

interface CategoryFormDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode: 'create' | 'edit';
  readonly initial: CategoryFormData;
  readonly onSubmit: (data: CategoryFormData) => Promise<{ ok: boolean; error?: string }>;
}

function CategoryFormDialog({ open, onOpenChange, mode, initial, onSubmit }: CategoryFormDialogProps) {
  const [form, setForm] = React.useState<CategoryFormData>(initial);
  const [errors, setErrors] = React.useState<CategoryFormErrors>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [autoSlug, setAutoSlug] = React.useState(mode === 'create');

  React.useEffect(() => {
    if (open) {
      setForm(initial);
      setErrors({});
      setSubmitError(null);
      setSubmitting(false);
      setAutoSlug(mode === 'create');
    }
  }, [open, initial, mode]);

  function updateField(field: keyof CategoryFormData, value: string) {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      if (field === 'name' && autoSlug) {
        next.slug = nameToSlug(value);
      }
      return next;
    });
    if (errors[field]) {
      setErrors((prev) => {
        const { [field]: _, ...rest } = prev;
        return rest;
      });
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    // Validate
    const schema = mode === 'create' ? createCategorySchema : updateCategorySchema;
    const input = {
      name: form.name,
      slug: form.slug,
      audience: form.audience,
      description: form.description || undefined,
      icon: form.icon || undefined,
      displayOrder: Number(form.displayOrder) || 0,
    };

    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const fieldErrors: CategoryFormErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof CategoryFormErrors | undefined;
        if (field && !fieldErrors[field]) {
          fieldErrors[field] = issue.message;
        }
      }
      setErrors(fieldErrors);
      return;
    }

    setSubmitting(true);
    try {
      const result = await onSubmit(form);
      if (!result.ok) {
        setSubmitError(result.error ?? 'An error occurred.');
      } else {
        onOpenChange(false);
      }
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Create Category' : 'Edit Category'}</DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Add a new ticket category for customers and firms.'
              : 'Update the ticket category details.'}
          </DialogDescription>
        </DialogHeader>

        {submitError !== null && (
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
            {submitError}
          </div>
        )}

        <form noValidate onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
          {/* Name */}
          <FormField label="Name" htmlFor="cat-name" error={errors.name} required>
            <Input
              id="cat-name"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              maxLength={100}
              placeholder="e.g. Account Issues"
              aria-invalid={errors.name ? true : undefined}
            />
          </FormField>

          {/* Slug */}
          <FormField label="Slug" htmlFor="cat-slug" error={errors.slug} required description="URL-friendly identifier. Auto-generated from name.">
            <Input
              id="cat-slug"
              value={form.slug}
              onChange={(e) => {
                setAutoSlug(false);
                updateField('slug', e.target.value);
              }}
              maxLength={64}
              placeholder="e.g. account-issues"
              aria-invalid={errors.slug ? true : undefined}
            />
          </FormField>

          {/* Audience */}
          <FormField label="Audience" htmlFor="cat-audience" error={errors.audience}>
            <Select
              value={form.audience}
              onValueChange={(value) => updateField('audience', value)}
            >
              <SelectTrigger id="cat-audience">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUDIENCE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          {/* Description */}
          <FormField label="Description" htmlFor="cat-description" error={errors.description} description="Optional. Max 500 characters.">
            <textarea
              id="cat-description"
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Brief description of this category..."
              className={cn(
                'flex w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-transparent px-3 py-2 text-base sm:text-sm text-[var(--color-fg)] shadow-[var(--shadow-sm)] transition-colors placeholder:text-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-50 resize-y',
                errors.description && 'border-[var(--color-danger)]',
              )}
              aria-invalid={errors.description ? true : undefined}
            />
          </FormField>

          {/* Display Order */}
          <FormField label="Display Order" htmlFor="cat-order" error={errors.displayOrder} description="Lower number = appears first. 0-9999.">
            <Input
              id="cat-order"
              type="number"
              value={form.displayOrder}
              onChange={(e) => updateField('displayOrder', e.target.value)}
              min={0}
              max={9999}
              aria-invalid={errors.displayOrder ? true : undefined}
            />
          </FormField>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <LoadingButton type="submit" loading={submitting}>
              {mode === 'create' ? 'Create' : 'Save Changes'}
            </LoadingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  Delete confirmation dialog                                                 */
/* -------------------------------------------------------------------------- */

interface DeleteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly category: AdminCategory | null;
  readonly onConfirm: () => Promise<void>;
}

function DeleteDialog({ open, onOpenChange, category, onConfirm }: DeleteDialogProps) {
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setDeleting(false);
      setError(null);
    }
  }, [open]);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete category.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Category</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <strong>{category?.name}</strong>?
            If tickets reference this category, it will be deactivated instead.
          </DialogDescription>
        </DialogHeader>

        {error !== null && (
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <LoadingButton
            variant="destructive"
            loading={deleting}
            onClick={() => { void handleDelete(); }}
          >
            Delete
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  Audience badge                                                             */
/* -------------------------------------------------------------------------- */

function AudienceBadge({ audience }: { readonly audience: string }) {
  const variant = audience === 'any' ? 'secondary' : 'outline';
  return (
    <Badge variant={variant} className="text-[10px] capitalize">
      {audience}
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/*  Loading skeleton                                                           */
/* -------------------------------------------------------------------------- */

function CategoriesSkeleton() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function AdminCategoriesPage() {
  const router = useRouter();
  // Sub-route guard, the tickets nav uses read_all so Support admins
  // pass the top-level route guard, but category CRUD needs
  // category_manage (Admin+). Redirect those users back to the tickets
  // list with a toast instead of letting them mash buttons that 403.
  const { has: hasAdminPermission, isLoading: permissionsLoading } = useAdminPermissions();
  React.useEffect(() => {
    if (permissionsLoading) return;
    if (!hasAdminPermission('admin.ticket.category_manage')) {
      toast.error('You do not have access to ticket category management.');
      router.replace('/admin/tickets');
    }
  }, [permissionsLoading, hasAdminPermission, router]);

  const { categories, error, isLoading, mutate } = useAdminCategories();
  const { execute } = useAdminCategoryAction();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editCategory, setEditCategory] = React.useState<AdminCategory | null>(null);
  const [deleteCategory, setDeleteCategory] = React.useState<AdminCategory | null>(null);
  // Cat 38 destructive-reauth (Page 7 closure): admin/tickets/categories
  // PATCH + DELETE now requires password+TOTP. Reauth state captures the
  // pending mutation so the modal's onConfirm can replay it with the
  // verified envelope.
  const [editReauth, setEditReauth] = React.useState<
    | { readonly target: AdminCategory; readonly data: CategoryFormData }
    | null
  >(null);
  const [toggleReauthTarget, setToggleReauthTarget] = React.useState<AdminCategory | null>(null);
  const [deleteReauthTarget, setDeleteReauthTarget] = React.useState<AdminCategory | null>(null);

  /* ---- Create (no reauth, POST is not destructive; spec reserves
   *       reauth for state-mutating-after-creation paths). ---- */
  async function handleCreate(data: CategoryFormData): Promise<{ ok: boolean; error?: string }> {
    const res = await execute('/api/internal/admin/tickets/categories', {
      method: 'POST',
      body: {
        name: data.name,
        slug: data.slug,
        audience: data.audience,
        description: data.description || undefined,
        icon: data.icon || undefined,
        displayOrder: Number(data.displayOrder) || 0,
      },
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = body['error'] as Record<string, unknown> | undefined;
      return { ok: false, error: (err?.['message'] as string | undefined) ?? 'Failed to create category.' };
    }

    void mutate();
    return { ok: true };
  }

  /* ---- Edit (step 1, capture form data, defer to reauth modal) ---- */
  async function handleEdit(data: CategoryFormData): Promise<{ ok: boolean; error?: string }> {
    if (!editCategory) return { ok: false, error: 'No category selected.' };
    setEditReauth({ target: editCategory, data });
    setEditCategory(null);
    return { ok: true };
  }

  /* ---- Edit (step 2, replay PATCH with reauth envelope) ---- */
  async function handleEditConfirmed({
    currentPassword,
    totpCode,
  }: {
    currentPassword: string;
    totpCode: string;
  }): Promise<void> {
    if (!editReauth) return;
    const { target, data } = editReauth;
    const res = await execute(`/api/internal/admin/tickets/categories/${target.id}`, {
      method: 'PATCH',
      body: {
        name: data.name,
        slug: data.slug,
        audience: data.audience,
        description: data.description || undefined,
        icon: data.icon || undefined,
        displayOrder: Number(data.displayOrder) || 0,
        currentPassword,
        totpCode,
      },
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = body['error'] as Record<string, unknown> | undefined;
      throw new Error((err?.['message'] as string | undefined) ?? 'Failed to update category.');
    }

    setEditReauth(null);
    void mutate();
  }

  /* ---- Delete (step 1, open reauth modal) ---- */
  function handleDelete(): void {
    if (!deleteCategory) return;
    setDeleteReauthTarget(deleteCategory);
    setDeleteCategory(null);
  }

  /* ---- Delete (step 2, replay DELETE with reauth envelope) ---- */
  async function handleDeleteConfirmed({
    currentPassword,
    totpCode,
  }: {
    currentPassword: string;
    totpCode: string;
  }): Promise<void> {
    if (!deleteReauthTarget) return;
    const res = await execute(`/api/internal/admin/tickets/categories/${deleteReauthTarget.id}`, {
      method: 'DELETE',
      body: { currentPassword, totpCode },
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = body['error'] as Record<string, unknown> | undefined;
      throw new Error((err?.['message'] as string | undefined) ?? 'Failed to delete category.');
    }

    setDeleteReauthTarget(null);
    void mutate();
  }

  /* ---- Toggle active (step 1, open reauth modal) ---- */
  function handleToggleActive(cat: AdminCategory): void {
    setToggleReauthTarget(cat);
  }

  /* ---- Toggle active (step 2, replay PATCH with reauth envelope) ---- */
  async function handleToggleConfirmed({
    currentPassword,
    totpCode,
  }: {
    currentPassword: string;
    totpCode: string;
  }): Promise<void> {
    if (!toggleReauthTarget) return;
    const res = await execute(`/api/internal/admin/tickets/categories/${toggleReauthTarget.id}`, {
      method: 'PATCH',
      body: {
        isActive: !toggleReauthTarget.isActive,
        currentPassword,
        totpCode,
      },
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const err = body['error'] as Record<string, unknown> | undefined;
      throw new Error((err?.['message'] as string | undefined) ?? 'Failed to toggle category.');
    }

    setToggleReauthTarget(null);
    void mutate();
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href="/admin/tickets">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Tickets
            </Link>
          </Button>
          <h1 className="text-xl font-bold text-[var(--color-fg)]">
            Categories ({categories.length})
          </h1>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
          New Category
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
          Failed to load categories.
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => { void mutate(); }}>
            Retry
          </Button>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <CategoriesSkeleton />
      ) : categories.length === 0 ? (
        <EmptyState
          icon={<Tags className="h-6 w-6" aria-hidden="true" />}
          title="No categories"
          description="Create your first ticket category to organize customer support."
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">Order</th>
                <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">Name</th>
                <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">Slug</th>
                <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">Audience</th>
                <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">Status</th>
                <th scope="col" className="px-4 py-3 font-medium text-[var(--color-muted)]">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {categories.map((cat) => (
                <tr key={cat.id} className={cn(
                  'transition-colors hover:bg-[var(--color-surface)]/50',
                  !cat.isActive && 'opacity-60',
                )}>
                  <td className="px-4 py-3 text-[var(--color-muted)] font-mono text-xs">
                    {cat.displayOrder}
                  </td>
                  <td className="px-4 py-3 font-medium text-[var(--color-fg)]">
                    {cat.name}
                    {cat.description && (
                      <p className="mt-0.5 text-xs text-[var(--color-muted)] line-clamp-1">
                        {cat.description}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--color-muted)]">
                    {cat.slug}
                  </td>
                  <td className="px-4 py-3">
                    <AudienceBadge audience={cat.audience} />
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => { void handleToggleActive(cat); }}
                      className="inline-flex"
                    >
                      <Badge
                        variant={cat.isActive ? 'default' : 'secondary'}
                        className={cn(
                          'text-[10px]',
                          cat.isActive
                            ? 'bg-[var(--color-success)]/10 text-[var(--color-success)] hover:bg-[var(--color-success)]/20'
                            : 'hover:bg-[var(--color-surface-hover)]',
                        )}
                      >
                        {cat.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${cat.name}`}
                        onClick={() => setEditCategory(cat)}
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${cat.name}`}
                        onClick={() => setDeleteCategory(cat)}
                      >
                        <Trash2 className="h-4 w-4 text-[var(--color-danger)]" aria-hidden="true" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create dialog */}
      <CategoryFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        mode="create"
        initial={EMPTY_FORM}
        onSubmit={handleCreate}
      />

      {/* Edit dialog */}
      <CategoryFormDialog
        open={editCategory !== null}
        onOpenChange={(open) => { if (!open) setEditCategory(null); }}
        mode="edit"
        initial={editCategory ? categoryToForm(editCategory) : EMPTY_FORM}
        onSubmit={handleEdit}
      />

      {/* Delete dialog (step 1, confirm intent) */}
      <DeleteDialog
        open={deleteCategory !== null}
        onOpenChange={(open) => { if (!open) setDeleteCategory(null); }}
        category={deleteCategory}
        onConfirm={async () => {
          handleDelete();
        }}
      />

      {/* Edit reauth (step 2, password + TOTP) */}
      <DestructiveReauthModal
        open={editReauth !== null}
        onOpenChange={(open) => {
          if (!open) setEditReauth(null);
        }}
        audience="admin"
        title="Update category"
        description={
          editReauth === null
            ? ''
            : `Updating "${editReauth.target.name}" applies the new shape to every ticket already filed under it. Confirm with your password and authenticator code.`
        }
        confirmLabel="Save changes"
        onConfirm={handleEditConfirmed}
      />

      {/* Toggle reauth */}
      <DestructiveReauthModal
        open={toggleReauthTarget !== null}
        onOpenChange={(open) => {
          if (!open) setToggleReauthTarget(null);
        }}
        audience="admin"
        title={
          toggleReauthTarget === null
            ? ''
            : toggleReauthTarget.isActive
              ? 'Deactivate category'
              : 'Activate category'
        }
        description={
          toggleReauthTarget === null
            ? ''
            : `Flipping "${toggleReauthTarget.name}" to ${toggleReauthTarget.isActive ? 'inactive' : 'active'} affects which audiences see it on the ticket form. Confirm with your password and authenticator code.`
        }
        confirmLabel={
          toggleReauthTarget === null
            ? ''
            : toggleReauthTarget.isActive
              ? 'Deactivate'
              : 'Activate'
        }
        onConfirm={handleToggleConfirmed}
      />

      {/* Delete reauth */}
      <DestructiveReauthModal
        open={deleteReauthTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteReauthTarget(null);
        }}
        audience="admin"
        destructive
        title="Delete category"
        description={
          deleteReauthTarget === null
            ? ''
            : `Deleting "${deleteReauthTarget.name}" deactivates the category if any tickets reference it, hard-deletes otherwise. Confirm with your password and authenticator code.`
        }
        confirmLabel="Delete category"
        onConfirm={handleDeleteConfirmed}
      />
    </div>
  );
}
