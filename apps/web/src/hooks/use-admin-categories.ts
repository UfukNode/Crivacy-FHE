'use client';

import useSWR from 'swr';
import * as React from 'react';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface AdminCategory {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly audience: 'customer' | 'firm' | 'any';
  readonly icon: string | null;
  readonly displayOrder: number;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AdminCategoryListResponse {
  readonly categories: readonly AdminCategory[];
}

/* -------------------------------------------------------------------------- */
/*  Hooks — uses layout SWR config (cookie-based, auto-refresh)              */
/* -------------------------------------------------------------------------- */

/**
 * SWR hook for admin ticket category list.
 * Fetches from `/api/internal/admin/tickets/categories` using layout SWR config.
 */
export function useAdminCategories() {
  const { data, error, isLoading, mutate } = useSWR<AdminCategoryListResponse>(
    '/api/internal/admin/tickets/categories',
  );

  return {
    categories: data?.categories ?? [],
    error,
    isLoading,
    mutate,
  } as const;
}

/**
 * Helper to make admin-authenticated mutation requests for categories.
 * Uses httpOnly cookie auth (credentials: 'include').
 */
export function useAdminCategoryAction() {
  const execute = React.useCallback(async (url: string, options: {
    readonly method: string;
    readonly body?: Record<string, unknown>;
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
