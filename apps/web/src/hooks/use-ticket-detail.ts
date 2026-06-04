'use client';

import useSWR from 'swr';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface Ticket {
  readonly id: string;
  readonly referenceNumber: string;
  readonly subject: string;
  readonly status: string;
  readonly priority: string;
  readonly categoryName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TicketAttachment {
  readonly id: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly url: string;
}

interface TicketMessage {
  readonly id: string;
  readonly senderId: string | null;
  readonly senderType: string;
  readonly senderName: string | null;
  readonly body: string;
  readonly isInternal: boolean;
  /**
   * Flips to `true` the first time an admin loads the ticket detail.
   * UI uses this for the read indicator AND the edit-lock (author
   * may only edit while `seenByOther === false`).
   */
  readonly seenByOther: boolean;
  readonly editedAt: string | null;
  readonly createdAt: string;
  readonly attachments?: readonly TicketAttachment[];
}

interface TicketDetail {
  readonly ticket: Ticket;
  readonly messages: readonly TicketMessage[];
}

/* -------------------------------------------------------------------------- */
/*  Hook                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * SWR hook for a single ticket with its messages.
 * Fetches from `/api/customer/tickets/:id` with cookie-based auth.
 *
 * Pass `null` for ticketId to skip fetching (conditional SWR).
 */
export function useTicketDetail(ticketId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<TicketDetail>(
    ticketId ? `/api/customer/tickets/${ticketId}` : null,
  );

  return {
    detail: data ?? null,
    error,
    isLoading,
    mutate,
  } as const;
}

export type { Ticket, TicketMessage, TicketAttachment, TicketDetail };
