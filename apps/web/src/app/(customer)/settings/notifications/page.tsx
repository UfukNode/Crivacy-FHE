'use client';

import * as React from 'react';
import { Lock } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadingButton } from '@/components/shared/loading-button';

/* -------------------------------------------------------------------------- */
/*  Event type definitions                                                    */
/* -------------------------------------------------------------------------- */

interface EventTypeConfig {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly locked: boolean;
}

const EVENT_TYPES: readonly EventTypeConfig[] = [
  {
    key: 'kyc.status_changed',
    label: 'KYC status changed',
    description: 'When your identity verification status is updated.',
    locked: false,
  },
  {
    key: 'credential.issued',
    label: 'Credential issued',
    description: 'When a new credential is issued to your account.',
    locked: false,
  },
  {
    key: 'credential.revoked',
    label: 'Credential revoked',
    description: 'When one of your credentials is revoked.',
    locked: false,
  },
  {
    key: 'ticket.reply',
    label: 'Ticket reply received',
    description: 'When a support agent replies to your ticket.',
    locked: false,
  },
  {
    key: 'ticket.status_changed',
    label: 'Ticket status changed',
    description: 'When the status of your support ticket changes.',
    locked: false,
  },
  {
    key: 'session.new_device',
    label: 'New sign-in detected',
    description: 'When a new device signs in to your account.',
    locked: true,
  },
  {
    key: 'password.changed',
    label: 'Password changed',
    description: 'When your account password is changed.',
    locked: true,
  },
] as const;

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface PreferenceEntry {
  eventType: string;
  channelInApp: boolean;
  channelEmail: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export default function NotificationPreferencesPage() {
  const [preferences, setPreferences] = React.useState<PreferenceEntry[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);

  // Track initial state for dirty check
  const initialPrefsRef = React.useRef<string>('');
  const isDirty = React.useMemo(() => {
    return JSON.stringify(preferences) !== initialPrefsRef.current;
  }, [preferences]);

  // --- Load preferences ---
  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/customer/notifications/preferences', {
          credentials: 'include',
        });

        if (!res.ok) {
          setLoadError(true);
          return;
        }

        const body = await res.json() as { preferences: PreferenceEntry[] };

        if (cancelled) return;

        // Merge server preferences with our event type list.
        // Events not in the server response default to all-enabled.
        const serverPrefs = body.preferences;
        const merged: PreferenceEntry[] = EVENT_TYPES.map((evt) => {
          const existing = serverPrefs.find((p) => p.eventType === evt.key);
          if (existing !== undefined) {
            return {
              eventType: evt.key,
              channelInApp: evt.locked ? true : existing.channelInApp,
              channelEmail: evt.locked ? true : existing.channelEmail,
            };
          }
          return {
            eventType: evt.key,
            channelInApp: true,
            channelEmail: true,
          };
        });

        setPreferences(merged);
        initialPrefsRef.current = JSON.stringify(merged);
      } catch {
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, []);

  // --- Toggle handler ---
  const handleToggle = React.useCallback(
    (eventType: string, channel: 'channelInApp' | 'channelEmail', value: boolean) => {
      setPreferences((prev) =>
        prev.map((p) => {
          if (p.eventType !== eventType) return p;
          return { ...p, [channel]: value };
        }),
      );
    },
    [],
  );

  // --- Save ---
  const handleSave = React.useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/customer/notifications/preferences', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferences: preferences.filter((p) => {
            // Only send non-locked preferences
            const config = EVENT_TYPES.find((e) => e.key === p.eventType);
            return config !== undefined && !config.locked;
          }),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        toast.error(body?.error?.message ?? 'Failed to update preferences.');
        return;
      }

      initialPrefsRef.current = JSON.stringify(preferences);
      toast.success('Notification preferences updated.');
    } catch {
      toast.error('An unexpected error occurred.');
    } finally {
      setSaving(false);
    }
  }, [preferences]);

  // --- Loading skeleton ---
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="mt-1 h-4 w-72" />
        </CardHeader>
        <CardContent className="space-y-4">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center justify-between py-3">
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-64" />
              </div>
              <div className="flex gap-8">
                <Skeleton className="h-5 w-10 rounded-full" />
                <Skeleton className="h-5 w-10 rounded-full" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm text-[var(--color-muted)]">
            Unable to load notification preferences. Please try refreshing the page.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification preferences</CardTitle>
        <CardDescription>
          Choose how you want to be notified about different events.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Header row */}
        <div className="mb-2 flex items-center justify-end gap-8 pr-1">
          <span className="w-12 text-center text-xs font-medium text-[var(--color-muted)]">
            In-App
          </span>
          <span className="w-12 text-center text-xs font-medium text-[var(--color-muted)]">
            Email
          </span>
        </div>

        {/* Event rows */}
        <div className="divide-y divide-[var(--color-border)]">
          {EVENT_TYPES.map((evt) => {
            const pref = preferences.find((p) => p.eventType === evt.key);
            const inApp = pref?.channelInApp ?? true;
            const email = pref?.channelEmail ?? true;

            return (
              <div
                key={evt.key}
                className="flex items-center justify-between py-3"
              >
                <div className="min-w-0 flex-1 pr-4">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-medium text-[var(--color-fg)]">
                      {evt.label}
                    </Label>
                    {evt.locked && (
                      <Lock
                        className="h-3.5 w-3.5 text-[var(--color-muted)]"
                        aria-label="Always enabled"
                      />
                    )}
                  </div>
                  <p className="text-xs text-[var(--color-muted)]">{evt.description}</p>
                </div>
                <div className="flex items-center gap-8">
                  <div className="flex w-12 justify-center">
                    <Switch
                      checked={inApp}
                      onCheckedChange={(checked) =>
                        handleToggle(evt.key, 'channelInApp', checked)
                      }
                      disabled={evt.locked || saving}
                      aria-label={`${evt.label} in-app notification`}
                    />
                  </div>
                  <div className="flex w-12 justify-center">
                    <Switch
                      checked={email}
                      onCheckedChange={(checked) =>
                        handleToggle(evt.key, 'channelEmail', checked)
                      }
                      disabled={evt.locked || saving}
                      aria-label={`${evt.label} email notification`}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Save button */}
        <div className="mt-6 flex justify-end">
          <LoadingButton
            loading={saving}
            disabled={!isDirty}
            onClick={handleSave}
            aria-label="Save notification preferences"
          >
            Save preferences
          </LoadingButton>
        </div>
      </CardContent>
    </Card>
  );
}
