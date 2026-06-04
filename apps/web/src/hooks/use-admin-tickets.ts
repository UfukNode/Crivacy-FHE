'use client';

import * as React from 'react';
import useSWR from 'swr';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Discriminated-union describing who opened the ticket. Server joins
 * the right side based on `creator_type` and the UI can render the
 * correct label + secondary metadata (firm tier, for instance)
 * without branching on string fields.
 */
type AdminTicketCreator =
  | {
      readonly kind: 'customer';
      readonly label: string;
      readonly email: string;
      readonly firmTier: null;
    }
  | {
      readonly kind: 'firm_user';
      readonly label: string;
      readonly email: string;
      readonly firmTier: string | null;
    };

interface AdminTicket {
  readonly id: string;
  readonly referenceNumber: string;
  readonly subject: string;
  readonly status: string;
  readonly priority: string;
  readonly categoryName: string;
  readonly customerEmail: string;
  readonly customerName: string | null;
  readonly creator: AdminTicketCreator;
  readonly assignedTo: string | null;
  readonly assignedToName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * The caller's relationship to this row. `null` when the caller has no
   * participant entry (e.g. superadmin viewing a ticket they haven't
   * been invited to, or an admin seeing the unassigned pickup pool).
   */
  readonly viewerParticipantRole: 'assignee' | 'collaborator' | null;
  readonly viewerParticipantStatus: 'active' | 'pending' | null;
}

type AdminTicketView = 'inbox' | 'invites' | 'team' | 'all';

interface AdminUserOption {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
}

interface AdminUsersResponse {
  readonly data: readonly AdminUserOption[];
  readonly pagination: {
    readonly nextCursor: string | null;
    readonly limit: number;
  };
}

interface AdminTicketListResponse {
  readonly tickets: readonly AdminTicket[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly totalPages: number;
  readonly view: AdminTicketView;
  readonly pendingInvitesCount: number;
}

interface AdminTicketMessage {
  readonly id: string;
  readonly senderId: string | null;
  readonly senderType: string;
  readonly senderName: string | null;
  readonly body: string;
  readonly isInternal: boolean;
  /**
   * `true` after any non-author has loaded the ticket detail. Drives
   * the WhatsApp-style read indicator (gray ✓✓ when false,
   * accent-colored ✓✓ when true) and the edit-lock: once true, the
   * author can no longer PATCH the body.
   */
  readonly seenByOther: boolean;
  /** Timestamp of the last edit (null when never edited). */
  readonly editedAt: string | null;
  readonly createdAt: string;
}

/**
 * A ticket participant as surfaced by `GET /api/internal/admin/tickets/:id`.
 * Mirrors `TicketParticipantSummary` on the server so the shapes stay in
 * lock-step; any change here must be mirrored in `lib/ticket/visibility.ts`.
 */
interface AdminTicketParticipant {
  readonly adminUserId: string;
  readonly displayName: string;
  readonly email: string;
  readonly adminRole: 'superadmin' | 'admin' | 'support';
  readonly role: 'assignee' | 'collaborator';
  readonly status: 'pending' | 'active' | 'declined' | 'removed';
  readonly muted: boolean;
  readonly invitedAt: string;
  readonly respondedAt: string | null;
  readonly expiresAt: string | null;
}

/**
 * Pre-computed capability flags surfaced by the server so the UI can hide
 * or disable controls without re-implementing the permission matrix. The
 * server still rechecks every mutation; these flags are advisory only.
 */
interface AdminTicketViewerCapabilities {
  readonly reply: boolean;
  readonly internalNote: boolean;
  readonly changeStatus: boolean;
  readonly changePriority: boolean;
  readonly reassign: boolean;
  readonly invite: boolean;
  readonly addParticipant: boolean;
  readonly removeParticipant: boolean;
  readonly takeOver: boolean;
  /**
   * Caller may self-claim the ticket via the "Assign to me" button.
   * Distinct from `reassign` because self-claim on an unassigned
   * ticket follows a dedicated transition (no reassign reason, no
   * stay-as-collab prompt) and is open to any non-pending admin, not
   * just the current assignee / superadmin.
   */
  readonly selfClaim: boolean;
}

interface AdminTicketViewer {
  readonly role: 'superadmin' | 'admin' | 'support';
  readonly participant: {
    readonly role: 'assignee' | 'collaborator';
    readonly status: 'pending' | 'active' | 'declined' | 'removed';
  } | null;
  readonly capabilities: AdminTicketViewerCapabilities;
}

interface AdminTicketDetail {
  readonly ticket: AdminTicket;
  readonly messages: readonly AdminTicketMessage[];
  readonly participants: readonly AdminTicketParticipant[];
  readonly viewer: AdminTicketViewer;
}

/* -------------------------------------------------------------------------- */
/*  Hooks — uses layout SWR config (cookie-based, auto-refresh)              */
/* -------------------------------------------------------------------------- */

interface AdminTicketsFilters {
  readonly status?: string;
  readonly priority?: string;
  readonly categoryId?: string;
  readonly assignedTo?: string;
  readonly search?: string;
  readonly view?: AdminTicketView;
}

/**
 * SWR hook for admin ticket list.
 * Fetches from `/api/internal/admin/tickets` using layout SWR config.
 */
export function useAdminTickets(filters?: AdminTicketsFilters) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.priority) params.set('priority', filters.priority);
  if (filters?.categoryId) params.set('categoryId', filters.categoryId);
  if (filters?.assignedTo) params.set('assignedTo', filters.assignedTo);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.view) params.set('view', filters.view);
  const qs = params.toString();
  const key = `/api/internal/admin/tickets${qs ? `?${qs}` : ''}`;

  const { data, error, isLoading, mutate } = useSWR<AdminTicketListResponse>(key);

  return {
    tickets: data?.tickets ?? [],
    total: data?.total ?? 0,
    pendingInvitesCount: data?.pendingInvitesCount ?? 0,
    view: data?.view ?? filters?.view ?? 'all',
    error,
    isLoading,
    mutate,
  } as const;
}

/**
 * SWR hook for a single admin ticket with messages (including internal notes).
 * Fetches from `/api/internal/admin/tickets/:id` using layout SWR config.
 */
export function useAdminTicketDetail(ticketId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<AdminTicketDetail>(
    ticketId ? `/api/internal/admin/tickets/${ticketId}` : null,
  );

  return {
    detail: data ?? null,
    error,
    isLoading,
    mutate,
  } as const;
}

/**
 * SWR hook for the roster of admin users eligible to be assigned a ticket.
 * Fetches from `/api/internal/admin/users`. Locked accounts are excluded
 * server-side, so the returned list is safe to use directly in a dropdown.
 */
export function useAdminUsers() {
  const { data, error, isLoading } = useSWR<AdminUsersResponse>(
    '/api/internal/admin/users',
  );

  return {
    users: data?.data ?? [],
    error,
    isLoading,
  } as const;
}

/**
 * Helper to make admin-authenticated POST/PATCH requests.
 * Uses httpOnly cookie auth (credentials: 'include').
 */
export function useAdminTicketAction() {
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

export type {
  AdminTicket,
  AdminTicketMessage,
  AdminTicketDetail,
  AdminTicketParticipant,
  AdminTicketView,
  AdminTicketViewer,
  AdminTicketViewerCapabilities,
  AdminTicketsFilters,
  AdminUserOption,
};
