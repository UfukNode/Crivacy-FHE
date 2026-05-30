'use client';

import * as React from 'react';
import useSWR from 'swr';

import {
  ChangePasswordForm,
  TotpManagementPanel,
  type RecoveryCodeDownloadContext,
} from '@/components/shared/security';
import { Separator } from '@/components/ui/separator';

/**
 * Admin settings → Security. Mirror of the firm security page on top
 * of the shared primitives, plus a change-password card (firm rotates
 * passwords through forgot-password, admin has an in-app form).
 *
 * Every audience ships the same TOTP management UX by design, any
 * edit to the shared primitive lands here automatically.
 */

interface AdminMe {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
}

const ADMIN_TOTP_ENDPOINTS = {
  status: '/api/internal/admin/profile/totp/status',
  setup: '/api/internal/admin/auth/totp/setup',
  replace: '/api/internal/admin/profile/totp/replace',
  disable: '/api/internal/admin/profile/totp/disable',
  regenerate: '/api/internal/admin/profile/recovery-codes/regenerate',
} as const;

export default function AdminSecuritySettingsPage() {
  const { data: me } = useSWR<AdminMe>('/api/internal/admin/me');

  const downloadContext = React.useMemo<RecoveryCodeDownloadContext | null>(() => {
    if (me === undefined) return null;
    return { email: me.email, audienceLabel: 'admin' };
  }, [me]);

  return (
    <div className="space-y-6">
      <TotpManagementPanel
        endpoints={ADMIN_TOTP_ENDPOINTS}
        downloadContext={downloadContext}
      />
      <Separator />
      <ChangePasswordForm
        endpoint="/api/internal/admin/profile/change-password"
        description="Rotate your admin password. Other active admin sessions will be revoked."
      />
    </div>
  );
}
