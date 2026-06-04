'use client';

import useSWR from 'swr';
import * as React from 'react';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface Permission {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly domain: string;
}

interface Role {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly userType: string;
  readonly isPreset: boolean;
  readonly isSystem: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

interface RolePermission {
  readonly permissionId: string;
  readonly code: string;
  readonly name: string;
  readonly domain: string;
  readonly grantedAt: string;
}

interface RoleDetail extends Role {
  readonly permissions: readonly RolePermission[];
}

interface PermissionsResponse {
  readonly data: readonly Permission[];
}

interface RolesResponse {
  readonly data: readonly Role[];
}

interface RoleDetailResponse {
  readonly data: RoleDetail;
}

interface RolePermissionCodesResponse {
  readonly data: readonly string[];
}

/* -------------------------------------------------------------------------- */
/*  Hooks — uses layout SWR config (cookie-based, auto-refresh)              */
/* -------------------------------------------------------------------------- */

/**
 * SWR hook for the full system permission catalogue. Fetches from
 * `/api/internal/admin/rbac/permissions` — returns every defined
 * permission code across all domains so the RBAC admin UI can
 * present a picker when an operator edits a role's permission set.
 *
 * NOT the same as `useAdminPermissions` in `use-admin-permissions.ts`,
 * which returns the *calling admin's* effective permission set. This
 * one returns the catalogue; that one returns the caller's rights.
 */
export function useAdminPermissionCatalog() {
  const { data, error, isLoading, mutate } = useSWR<PermissionsResponse>(
    '/api/internal/admin/rbac/permissions',
  );

  return {
    permissions: data?.data ?? [],
    error,
    isLoading,
    mutate,
  } as const;
}

/**
 * SWR hook for roles list with optional userType filter.
 * Fetches from `/api/internal/admin/rbac/roles`.
 */
export function useAdminRoles(userType?: string) {
  const params = new URLSearchParams();
  if (userType) params.set('userType', userType);
  const qs = params.toString();
  const key = `/api/internal/admin/rbac/roles${qs ? '?' + qs : ''}`;

  const { data, error, isLoading, mutate } = useSWR<RolesResponse>(key);

  return {
    roles: data?.data ?? [],
    error,
    isLoading,
    mutate,
  } as const;
}

/**
 * SWR hook for a single role with its permissions.
 * Fetches from `/api/internal/admin/rbac/roles/:id`.
 * Pass null to disable fetching.
 */
export function useAdminRoleDetail(roleId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<RoleDetailResponse>(
    roleId ? `/api/internal/admin/rbac/roles/${roleId}` : null,
  );

  return {
    role: data?.data ?? null,
    error,
    isLoading,
    mutate,
  } as const;
}

/**
 * Helper to make admin-authenticated POST/PATCH/PUT/DELETE requests.
 * Uses httpOnly cookie auth (credentials: 'include').
 */
export function useAdminRbacAction() {
  const execute = React.useCallback(async (url: string, options: {
    readonly method: string;
    readonly body?: Record<string, unknown> | readonly string[];
  }) => {
    const res = await fetch(url, {
      method: options.method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    return res;
  }, []);

  return { execute } as const;
}

export type {
  Permission,
  Role,
  RoleDetail,
  RolePermission,
  PermissionsResponse,
  RolesResponse,
  RoleDetailResponse,
  RolePermissionCodesResponse,
};
