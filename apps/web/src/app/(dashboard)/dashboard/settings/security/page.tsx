'use client';

import * as React from 'react';
import useSWR from 'swr';

import {
  TotpManagementPanel,
  type RecoveryCodeDownloadContext,
} from '@/components/shared/security';

/**
 * Firm dashboard → Settings → Security.
 *
 * Orchestrates the three TOTP management flows (replace / regenerate
 * recovery codes / disable) through the audience-agnostic
 * {@link TotpManagementPanel}. Endpoint URLs point at the firm-side
 * API; the panel handles status fetching, UI state, and response
 * mapping internally.
 *
 * Firm-specific behaviour is driven entirely by the status endpoint,
 * when `firmRequiresTotp` is true the Disable card automatically
 * refuses; no audience branching lives on the client.
 */

interface DashboardMe {
  readonly email: string;
  readonly firmName: string;
}

const FIRM_TOTP_ENDPOINTS = {
  status: '/api/internal/profile/totp/status',
  setup: '/api/internal/auth/totp/setup',
  replace: '/api/internal/profile/totp/replace',
  disable: '/api/internal/profile/totp/disable',
  regenerate: '/api/internal/profile/recovery-codes/regenerate',
} as const;

export default function SecuritySettingsPage() {
  // Shared with the dashboard shell via SWR de-dupe, so this does not
  // trigger a second network request.
  const { data: me } = useSWR<DashboardMe>('/api/internal/me');

  const downloadContext = React.useMemo<RecoveryCodeDownloadContext | null>(() => {
    if (me === undefined) return null;
    return { email: me.email, firmName: me.firmName, audienceLabel: 'firm' };
  }, [me]);

  return (
    <TotpManagementPanel
      endpoints={FIRM_TOTP_ENDPOINTS}
      downloadContext={downloadContext}
    />
  );
}
