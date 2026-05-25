'use client';

import * as React from 'react';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadingButton } from '@/components/shared/loading-button';
import { FormField } from '@/components/shared/form-field';
import { PhoneInput } from '@/components/shared/phone-input';
import { displayNameSchema, isValidPhoneNumber } from '@/lib/validation/profile';
import { AvatarUpload } from '@/components/shared/avatar-upload';
import { useCustomerProfile } from '@/hooks/use-customer-profile';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function formatFieldLabel(key: string): string {
  const labels: Record<string, string> = {
    fullName: 'Full name',
    dateOfBirth: 'Date of birth',
    nationality: 'Nationality',
    documentType: 'Document type',
    documentCountry: 'Document country',
    addressLine: 'Address',
    addressCity: 'City',
    addressCountry: 'Country',
  };
  return labels[key] ?? key;
}

const KYC_IDENTITY_FIELDS = [
  'fullName',
  'dateOfBirth',
  'nationality',
  'documentType',
  'documentCountry',
] as const;

const KYC_ADDRESS_FIELDS = [
  'addressLine',
  'addressCity',
  'addressCountry',
] as const;

type KycFieldKey = (typeof KYC_IDENTITY_FIELDS)[number] | (typeof KYC_ADDRESS_FIELDS)[number];

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export default function ProfileSettingsPage() {
  const { profile, isLoading, mutate } = useCustomerProfile();

  const [displayName, setDisplayName] = React.useState('');
  const [phone, setPhone] = React.useState<string | undefined>(undefined);
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Track whether form values have been initialized from profile
  const initializedRef = React.useRef(false);

  // Sync form state from profile on initial load
  React.useEffect(() => {
    if (profile !== null && !initializedRef.current) {
      setDisplayName(profile.displayName ?? '');
      setPhone(profile.phone ?? undefined);
      initializedRef.current = true;
    }
  }, [profile]);

  // Dirty check: compare current form values to profile
  const isDirty = React.useMemo(() => {
    if (profile === null) return false;
    const profileDisplayName = profile.displayName ?? '';
    const profilePhone = profile.phone ?? undefined;
    return displayName !== profileDisplayName || phone !== profilePhone;
  }, [profile, displayName, phone]);

  useUnsavedChanges(isDirty);

  // --- Avatar handlers ---
  const handleAvatarUploaded = React.useCallback(
    (_newUrl: string) => {
      void mutate();
      toast.success('Avatar updated.');
    },
    [mutate],
  );

  const handleRemoveAvatar = React.useCallback(async () => {
    try {
      const res = await fetch('/api/customer/avatar', {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        toast.error(body?.error?.message ?? 'Failed to remove avatar.');
        return;
      }
      void mutate();
      toast.success('Avatar removed.');
    } catch {
      toast.error('Failed to remove avatar.');
    }
  }, [mutate]);

  // --- Form submit ---
  const handleSave = React.useCallback(async () => {
    const newErrors: Record<string, string> = {};

    const trimmedDisplayName = displayName.trim();
    const hadDisplayName = (profile?.displayName ?? '').length > 0;

    if (trimmedDisplayName.length === 0 && hadDisplayName) {
      newErrors['displayName'] = 'Display name cannot be removed.';
    } else if (trimmedDisplayName.length > 0) {
      const displayNameResult = displayNameSchema.safeParse(trimmedDisplayName);
      if (!displayNameResult.success) {
        newErrors['displayName'] = displayNameResult.error.issues[0]?.message ?? 'Invalid display name.';
      }
    }

    if (phone !== undefined && phone.length > 0 && !isValidPhoneNumber(phone)) {
      newErrors['phone'] = 'Please enter a valid phone number.';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setErrors({});
    setSaving(true);

    try {
      const payload: Record<string, string> = {};
      if (profile !== null && displayName !== (profile.displayName ?? '')) {
        payload['displayName'] = displayName.trim();
      }
      if (profile !== null && phone !== (profile.phone ?? undefined)) {
        if (phone !== undefined && phone.length > 0) {
          payload['phone'] = phone;
        }
      }

      if (Object.keys(payload).length === 0) {
        toast.info('No changes to save.');
        return;
      }

      const res = await fetch('/api/customer/profile', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string; details?: { issues?: Array<{ path: Array<string | number>; message: string }> } } } | null;
        if (body?.error?.details?.issues) {
          const fieldErrors: Record<string, string> = {};
          for (const issue of body.error.details.issues) {
            const field = issue.path[0];
            if (typeof field === 'string') {
              fieldErrors[field] = issue.message;
            }
          }
          setErrors(fieldErrors);
        } else {
          toast.error(body?.error?.message ?? 'Failed to update profile.');
        }
        return;
      }

      void mutate();
      toast.success('Profile updated.');
    } catch {
      toast.error('An unexpected error occurred.');
    } finally {
      setSaving(false);
    }
  }, [displayName, phone, profile, mutate]);

  // --- Loading skeleton ---
  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
            <Skeleton className="mt-1 h-4 w-60" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-16 w-16 rounded-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (profile === null) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm text-[var(--color-muted)]">
            Unable to load your profile. Please try refreshing the page.
          </p>
        </CardContent>
      </Card>
    );
  }

  const phoneMutability = profile.mutability['phone'];
  const isPhoneLocked = phoneMutability === 'locked' || phoneMutability === 'immutable';

  // Gather KYC-verified fields that have values
  const kycFields = [...KYC_IDENTITY_FIELDS, ...KYC_ADDRESS_FIELDS].filter(
    (key: KycFieldKey) => profile[key] !== null && profile[key] !== undefined,
  );

  return (
    <div className="space-y-6">
      {/* Avatar + basic info */}
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your personal information and display settings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <AvatarUpload
              currentUrl={profile.avatarUrl}
              onUploadComplete={handleAvatarUploaded}
              user={{ id: profile.id, displayName: profile.displayName }}
            />
            <div className="space-y-1">
              <p className="text-sm font-medium text-[var(--color-fg)]">Profile photo</p>
              <p className="text-xs text-[var(--color-muted)]">JPEG, PNG, or WebP. Max 2 MB.</p>
              {profile.avatarUrl !== null && (
                <button
                  type="button"
                  onClick={handleRemoveAvatar}
                  className="text-xs text-[var(--color-danger)] hover:underline"
                  aria-label="Remove avatar"
                >
                  Remove avatar
                </button>
              )}
            </div>
          </div>

          <Separator />

          {/* Display name */}
          <FormField
            label="Display name"
            htmlFor="settings-display-name"
            error={errors['displayName']}
            required={(profile?.displayName ?? '').length > 0}
          >
            <Input
              id="settings-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={100}
              autoComplete="name"
              aria-describedby={errors['displayName'] ? 'settings-display-name-error' : undefined}
            />
          </FormField>

          {/* Email */}
          <FormField label="Email" htmlFor="settings-email">
            {profile.email !== null ? (
              <div className="space-y-1">
                <Input
                  id="settings-email"
                  value={profile.email}
                  disabled
                  readOnly
                  autoComplete="email"
                />
                <p className="text-xs text-[var(--color-muted)]">
                  <Link href="/settings/security" className="text-[var(--color-accent)] hover:underline">
                    Manage in Security settings
                  </Link>
                </p>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-muted)]">
                No email set.{' '}
                <Link href="/settings/security" className="text-[var(--color-accent)] hover:underline">
                  Add an email address
                </Link>{' '}
                to enable notifications and password recovery.
              </p>
            )}
          </FormField>

          {/* Phone */}
          <FormField
            label="Phone number"
            htmlFor="settings-phone"
            description={isPhoneLocked ? 'Verified by identity check. Contact support to change.' : undefined}
            error={errors['phone']}
          >
            {isPhoneLocked ? (
              <div className="relative">
                <Input
                  id="settings-phone"
                  value={profile.phone ?? ''}
                  disabled
                  readOnly
                  className="pr-10"
                />
                <Lock
                  className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]"
                  aria-hidden="true"
                />
              </div>
            ) : (
              <PhoneInput
                value={phone}
                onChange={setPhone}
                disabled={saving}
              />
            )}
          </FormField>

          {/* Save button */}
          <div className="flex justify-end">
            <LoadingButton
              loading={saving}
              disabled={!isDirty}
              onClick={handleSave}
              aria-label="Save profile changes"
            >
              Save changes
            </LoadingButton>
          </div>
        </CardContent>
      </Card>

      {/* KYC-verified fields */}
      {kycFields.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Verified information</CardTitle>
            <CardDescription>
              These fields were verified during your identity check and cannot be edited.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {kycFields.map((key: KycFieldKey) => {
              const value = profile[key];
              if (value === null || value === undefined) return null;

              return (
                <FormField
                  key={key}
                  label={formatFieldLabel(key)}
                  htmlFor={`kyc-field-${key}`}
                >
                  <div className="relative">
                    <Input
                      id={`kyc-field-${key}`}
                      value={String(value)}
                      disabled
                      readOnly
                      className="pr-10"
                    />
                    <Lock
                      className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]"
                      aria-hidden="true"
                    />
                  </div>
                </FormField>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
