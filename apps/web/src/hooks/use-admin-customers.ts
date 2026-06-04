'use client';

import useSWR from 'swr';
import * as React from 'react';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface AdminCustomer {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly status: string;
  readonly kycLevel: string;
  readonly kycScore: number;
  readonly fullName: string | null;
  readonly emailVerifiedAt: string | null;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

interface AdminCustomerListResponse {
  readonly customers: readonly AdminCustomer[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly totalPages: number;
}

interface AdminKycSession {
  readonly id: string;
  readonly workflowType: string;
  readonly status: string;
  readonly diditSessionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AdminCredential {
  readonly id: string;
  readonly level: string;
  readonly status: string;
  readonly identityVerified: boolean;
  readonly addressVerified: boolean;
  readonly chainContractId: string | null;
  readonly chainNetwork: string | null;
  readonly chainUpdateId: string | null;
  readonly supersededBy: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  readonly nftContractId: string | null;
  readonly nftMintedAt: string | null;
  readonly nftBurnedAt: string | null;
  readonly nftChainUpdateId: string | null;
}

interface AdminCustomerTicket {
  readonly id: string;
  readonly referenceNumber: string;
  readonly subject: string;
  readonly status: string;
  readonly createdAt: string;
}

interface AdminCustomerRole {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly isPreset: boolean;
  readonly isSystem: boolean;
}

interface AdminCustomerDetailData {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly status: string;
  readonly kycLevel: string;
  readonly kycScore: number;
  readonly phone: string | null;
  readonly fullName: string | null;
  readonly dateOfBirth: string | null;
  readonly nationality: string | null;
  readonly documentType: string | null;
  readonly documentCountry: string | null;
  readonly addressLine: string | null;
  readonly addressCity: string | null;
  readonly addressCountry: string | null;
  readonly kycFieldsLocked: boolean;
  readonly emailVerifiedAt: string | null;
  readonly lockedAt: string | null;
  readonly lockReason: string | null;
  readonly failedLoginAttempts: number;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AdminCustomerDetail {
  readonly customer: AdminCustomerDetailData;
  readonly kycSessions: readonly AdminKycSession[];
  readonly credentials: readonly AdminCredential[];
  readonly recentTickets: readonly AdminCustomerTicket[];
  readonly roles: readonly AdminCustomerRole[];
}

/* -------------------------------------------------------------------------- */
/*  Hooks — uses layout SWR config (cookie-based, auto-refresh)              */
/* -------------------------------------------------------------------------- */

interface AdminCustomersFilters {
  readonly search?: string;
  readonly status?: string;
  readonly kycLevel?: string;
  readonly page?: number;
  readonly limit?: number;
}

/**
 * SWR hook for admin customer list with search, filter, and pagination.
 * Fetches from `/api/internal/admin/customers` using layout SWR config.
 */
export function useAdminCustomers(filters?: AdminCustomersFilters) {
  const params = new URLSearchParams();
  if (filters?.search) params.set('search', filters.search);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.kycLevel) params.set('kycLevel', filters.kycLevel);
  if (filters?.page !== undefined) params.set('page', String(filters.page));
  if (filters?.limit !== undefined) params.set('limit', String(filters.limit));
  const qs = params.toString();
  const key = `/api/internal/admin/customers${qs ? '?' + qs : ''}`;

  const { data, error, isLoading, mutate } = useSWR<AdminCustomerListResponse>(key);

  return {
    customers: data?.customers ?? [],
    total: data?.total ?? 0,
    page: data?.page ?? 1,
    limit: data?.limit ?? 20,
    totalPages: data?.totalPages ?? 1,
    error,
    isLoading,
    mutate,
  } as const;
}

/**
 * SWR hook for a single customer detail with all related data.
 * Fetches from `/api/internal/admin/customers/:id` using layout SWR config.
 */
export function useAdminCustomerDetail(customerId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<AdminCustomerDetail>(
    customerId ? `/api/internal/admin/customers/${customerId}` : null,
  );

  return {
    detail: data ?? null,
    error,
    isLoading,
    mutate,
  } as const;
}

/**
 * Helper to make admin-authenticated PATCH requests for customer actions.
 * Uses httpOnly cookie auth (credentials: 'include').
 *
 * BUG #58: customer status mutation (suspend/lock/ban/unban/activate/
 * reset_kyc) is gated on password+TOTP reauth at the route handler.
 * The envelope is mandatory; `useAdminCustomerAction` accepts it as
 * the third argument and merges with `action` + optional `reason`.
 */
export function useAdminCustomerAction() {
  const execute = React.useCallback(
    async (
      customerId: string,
      action: string,
      reason: string | undefined,
      envelope: { currentPassword: string; totpCode: string },
    ) => {
      const body: Record<string, unknown> = {
        action,
        currentPassword: envelope.currentPassword,
        totpCode: envelope.totpCode,
      };
      if (reason !== undefined && reason.trim() !== '') {
        body['reason'] = reason.trim();
      }

      const res = await fetch(`/api/internal/admin/customers/${customerId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      return res;
    },
    [],
  );

  return { execute } as const;
}

export type {
  AdminCustomer,
  AdminCustomerDetail,
  AdminCustomerDetailData,
  AdminCustomersFilters,
  AdminKycSession,
  AdminCredential,
  AdminCustomerTicket,
  AdminCustomerRole,
};
