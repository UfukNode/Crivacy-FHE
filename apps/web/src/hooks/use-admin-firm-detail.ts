'use client';

import useSWR from 'swr';
import { useCallback } from 'react';

export interface AdminFirmDetailFirm {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly tier: string;
  readonly contactEmail: string | null;
  readonly billingEmail: string | null;
  readonly countryCode: string | null;
  readonly supportUrl: string | null;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminFirmDetailUser {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly invitedAt: string | null;
  readonly acceptedAt: string | null;
  readonly lastLoginAt: string | null;
  readonly lockedAt: string | null;
  readonly createdAt: string;
}

export interface AdminFirmDetailApiKey {
  readonly id: string;
  readonly prefix: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly mode: string;
  readonly lastUsedAt: string | null;
  readonly lastUsedIp: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface AdminFirmDetailWebhookEndpoint {
  readonly id: string;
  readonly url: string;
  readonly label: string;
  readonly isActive: boolean;
  readonly events: readonly string[];
  readonly createdAt: string;
}

export interface AdminFirmDetailResponse {
  readonly firm: AdminFirmDetailFirm;
  readonly users: readonly AdminFirmDetailUser[];
  readonly apiKeys: readonly AdminFirmDetailApiKey[];
  readonly webhooks: {
    readonly endpoints: readonly AdminFirmDetailWebhookEndpoint[];
    readonly health: {
      readonly deliveries24h: number;
      readonly failures24h: number;
      readonly successRate: number | null;
    };
  };
  readonly tickets: Readonly<Record<string, number>>;
}

export function useAdminFirmDetail(firmId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<AdminFirmDetailResponse>(
    firmId !== null ? `/api/internal/admin/firms/${firmId}` : null,
  );

  return {
    detail: data ?? null,
    error,
    isLoading,
    mutate,
  } as const;
}

export function useAdminFirmAction() {
  const execute = useCallback(
    async (
      url: string,
      options: { readonly method: string; readonly body?: Record<string, unknown> },
    ) => {
      const res = await fetch(url, {
        method: options.method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      return res;
    },
    [],
  );
  return { execute } as const;
}
