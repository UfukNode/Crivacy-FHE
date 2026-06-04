'use client';

import useSWR from 'swr';
import { useCallback } from 'react';

/* -------------------------------------------------------------------------- */
/*  Types — mirror server response shapes                                     */
/* -------------------------------------------------------------------------- */

export interface FirmTicketSummary {
  readonly id: string;
  readonly referenceNumber: string;
  readonly subject: string;
  readonly status: string;
  readonly priority: string;
  readonly categoryName: string;
  readonly creatorEmail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface FirmTicketListResponse {
  readonly tickets: readonly FirmTicketSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface FirmTicketCategory {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly audience: string;
  readonly icon: string | null;
  readonly displayOrder: number;
}

interface FirmTicketCategoriesResponse {
  readonly categories: readonly FirmTicketCategory[];
}

export interface FirmTicketMessage {
  readonly id: string;
  readonly senderId: string | null;
  readonly senderType: string;
  readonly senderName: string | null;
  readonly body: string;
  readonly isInternal: boolean;
  readonly seenByOther: boolean;
  readonly editedAt: string | null;
  readonly createdAt: string;
}

export interface FirmTicketDetail {
  readonly ticket: {
    readonly id: string;
    readonly referenceNumber: string;
    readonly subject: string;
    readonly status: string;
    readonly priority: string;
    readonly categoryName: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly resolvedAt: string | null;
    readonly closedAt: string | null;
  };
  readonly messages: readonly FirmTicketMessage[];
}

/* -------------------------------------------------------------------------- */
/*  Hooks                                                                     */
/* -------------------------------------------------------------------------- */

interface FirmTicketFilters {
  readonly status?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export function useFirmTickets(filters?: FirmTicketFilters) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.cursor) params.set('cursor', filters.cursor);
  if (filters?.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  const key = `/api/internal/tickets${qs ? `?${qs}` : ''}`;

  const { data, error, isLoading, mutate } = useSWR<FirmTicketListResponse>(key);

  return {
    tickets: data?.tickets ?? [],
    nextCursor: data?.nextCursor ?? null,
    hasMore: data?.hasMore ?? false,
    isLoading,
    error,
    mutate,
  } as const;
}

export function useFirmTicketDetail(ticketId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<FirmTicketDetail>(
    ticketId !== null ? `/api/internal/tickets/${ticketId}` : null,
  );

  return {
    detail: data ?? null,
    isLoading,
    error,
    mutate,
  } as const;
}

export function useFirmTicketCategories() {
  const { data, error, isLoading } = useSWR<FirmTicketCategoriesResponse>(
    '/api/internal/tickets/categories',
  );

  return {
    categories: data?.categories ?? [],
    isLoading,
    error,
  } as const;
}

/**
 * Helper for firm ticket POST/PATCH requests. Uses httpOnly cookie auth.
 */
export function useFirmTicketAction() {
  const execute = useCallback(
    async (
      url: string,
      options: {
        readonly method: string;
        readonly body?: Record<string, unknown>;
      },
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
