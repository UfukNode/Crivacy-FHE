'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadingButton } from '@/components/shared/loading-button';
import { useFirmPermissions } from '@/hooks/use-firm-permissions';
import { FirmWalletConnect } from './firm-wallet-connect';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FirmProfile {
  id: string;
  name: string;
  slug: string;
  tier: string;
  contactEmail: string | null;
  billingEmail: string | null;
  supportUrl: string | null;
  createdAt: string;
}

interface FirmSettings {
  totpRequired: boolean;
  dataRetentionDays: number;
  ipAllowlist: readonly string[] | null;
}

interface FirmProfileResponse {
  firm: FirmProfile;
  settings: FirmSettings | null;
}


// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function SettingsSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-10 w-full" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-10 w-full max-w-md" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Firm settings page -- view and update firm profile.
 */
export default function SettingsPage() {
  const { data: profile, error, isLoading, mutate } = useSWR<FirmProfileResponse>('/api/internal/firm');

  // Admin+ can mutate firm settings per matrix. Member/Viewer can
  // only read, the Save button stays hidden so the form reads as a
  // view-only detail card for them.
  const { has: hasFirmPermission } = useFirmPermissions();
  const canUpdate = hasFirmPermission('firm.update');

  // Form state
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [supportUrl, setSupportUrl] = useState('');
  const [saving, setSaving] = useState(false);

  // Sync form state when data loads
  useEffect(() => {
    if (profile) {
      setName(profile.firm.name);
      setContactEmail(profile.firm.contactEmail ?? '');
      setBillingEmail(profile.firm.billingEmail ?? '');
      setSupportUrl(profile.firm.supportUrl ?? '');
    }
  }, [profile]);

  async function handleSave() {
    if (name.trim().length === 0) {
      toast.error('Firm name is required.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/internal/firm', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          ...(contactEmail.length > 0 ? { contactEmail } : {}),
          ...(billingEmail.length > 0 ? { billingEmail } : {}),
          ...(supportUrl.length > 0 ? { supportUrl } : {}),
        }),
      });

      if (!res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        const err = body['error'] as Record<string, unknown> | undefined;
        toast.error((err?.['message'] as string) ?? 'Failed to save settings.');
        return;
      }

      toast.success('Settings saved successfully.');
      void mutate();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Error state */}
      {error && !isLoading && (
        <Card className="border-[var(--color-danger)]/30">
          <CardContent className="pt-6">
            <p className="text-sm text-[var(--color-danger)]">
              Failed to load firm profile. Please try refreshing the page.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Loading state */}
      {isLoading && <SettingsSkeleton />}

      {/* Content */}
      {!isLoading && profile && (
        <>
          {/* Read-only firm info */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Firm Information</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-[var(--color-muted)]">Slug</p>
                  <p className="font-mono text-sm">{profile.firm.slug}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-[var(--color-muted)]">Tier</p>
                  <p className="text-sm font-medium capitalize">{profile.firm.tier}</p>
                </div>
                {profile.settings !== null && (
                  <>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-[var(--color-muted)]">
                        TOTP Required
                      </p>
                      <p className="text-sm">
                        {profile.settings.totpRequired ? 'Yes' : 'No'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-[var(--color-muted)]">
                        Data Retention
                      </p>
                      <p className="text-sm">{profile.settings.dataRetentionDays} days</p>
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          <Separator />

          {/* Editable profile */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Edit Profile</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="max-w-md space-y-2">
                  <Label htmlFor="firm-name">Firm Name</Label>
                  <Input
                    id="firm-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>

                <div className="max-w-md space-y-2">
                  <Label htmlFor="contact-email">Contact Email</Label>
                  <Input
                    id="contact-email"
                    type="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                  />
                </div>

                <div className="max-w-md space-y-2">
                  <Label htmlFor="billing-email">Billing Email</Label>
                  <Input
                    id="billing-email"
                    type="email"
                    value={billingEmail}
                    onChange={(e) => setBillingEmail(e.target.value)}
                  />
                </div>

                <div className="max-w-md space-y-2">
                  <Label htmlFor="support-url">Support URL</Label>
                  <Input
                    id="support-url"
                    type="url"
                    value={supportUrl}
                    onChange={(e) => setSupportUrl(e.target.value)}
                    placeholder="https://support.yourcompany.com"
                  />
                </div>

                {canUpdate ? (
                  <div className="pt-2">
                    <LoadingButton loading={saving} onClick={handleSave}>
                      Save Changes
                    </LoadingButton>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Separator />

          {/* On-chain wallet (FHE grant target) */}
          <FirmWalletConnect canUpdate={canUpdate} />
        </>
      )}
    </div>
  );
}
