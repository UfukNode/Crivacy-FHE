'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadingButton } from '@/components/shared/loading-button';
import { TicketMessage } from '@/components/shared/ticket-message';
import { TicketStatusBadge } from '@/components/shared/ticket-status-badge';
import { TicketPriorityBadge } from '@/components/shared/ticket-priority-badge';
import { useDashboardUser } from '@/hooks/use-dashboard-user';
import {
  useFirmTicketAction,
  useFirmTicketDetail,
} from '@/hooks/use-firm-tickets';
import { cn } from '@/lib/utils';

const REPLY_MAX = 5000;

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-48" />
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    </div>
  );
}

export default function FirmTicketDetailPage() {
  const params = useParams();
  const rawId = params?.['id'];
  const ticketId = typeof rawId === 'string' ? rawId : null;
  const { detail, isLoading, error, mutate } = useFirmTicketDetail(ticketId);
  const { user } = useDashboardUser();
  const { execute } = useFirmTicketAction();
  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  const handleMessageEdit = React.useCallback(
    async (messageId: string, newBody: string): Promise<boolean> => {
      if (ticketId === null) return false;
      const res = await execute(`/api/internal/tickets/${ticketId}/messages/${messageId}`, {
        method: 'PATCH',
        body: { body: newBody },
      });
      if (!res.ok) return false;
      await mutate();
      return true;
    },
    [execute, mutate, ticketId],
  );

  const [reply, setReply] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (detail?.messages && detail.messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [detail?.messages]);

  async function handleSend(): Promise<void> {
    const trimmed = reply.trim();
    if (trimmed.length === 0 || ticketId === null) return;
    if (trimmed.length > REPLY_MAX) {
      setSendError(`Reply must be at most ${REPLY_MAX} characters.`);
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const res = await execute(`/api/internal/tickets/${ticketId}/messages`, {
        method: 'POST',
        body: { body: trimmed },
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = payload['error'] as Record<string, unknown> | undefined;
        setSendError((err?.['message'] as string | undefined) ?? 'Failed to send reply.');
        return;
      }
      setReply('');
      await mutate();
    } catch {
      setSendError('Network error. Please try again.');
    } finally {
      setSending(false);
    }
  }

  if (isLoading) return <DetailSkeleton />;

  if (error !== undefined || detail === null) {
    const status = (error as { status?: number } | undefined)?.status;
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/dashboard/tickets">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to Tickets
          </Link>
        </Button>
        <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-4 text-sm text-[var(--color-danger)]">
          {status === 404 ? 'Ticket not found.' : 'Failed to load ticket.'}
        </div>
      </div>
    );
  }

  const { ticket, messages } = detail;
  const isTerminal = ticket.status === 'resolved' || ticket.status === 'closed';

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/dashboard/tickets">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Tickets
        </Link>
      </Button>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-[var(--color-muted)]">
            {ticket.referenceNumber}
          </span>
          <TicketStatusBadge status={ticket.status} />
          <TicketPriorityBadge priority={ticket.priority} />
        </div>
        <h1 className="mt-1 text-xl font-bold text-[var(--color-fg)]">{ticket.subject}</h1>
        <p className="text-sm text-[var(--color-muted)]">{ticket.categoryName}</p>
      </div>

      <section aria-label="Ticket conversation" className="space-y-3">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--color-muted)]">No messages yet.</p>
        ) : (
          messages.map((msg) => (
            <TicketMessage
              key={msg.id}
              message={msg}
              currentUserId={user?.id ?? null}
              onEdit={handleMessageEdit}
            />
          ))
        )}
        <div ref={messagesEndRef} aria-hidden="true" />
      </section>

      {isTerminal ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-center text-sm text-[var(--color-muted)]">
          This ticket is {ticket.status}. Open a new ticket if you need further help.
        </div>
      ) : (
        <div className="space-y-2">
          {sendError !== null && (
            <div
              role="alert"
              className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]"
            >
              {sendError}
            </div>
          )}
          <div className="flex gap-2">
            <textarea
              value={reply}
              onChange={(e) => {
                setReply(e.target.value);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              maxLength={REPLY_MAX}
              rows={3}
              disabled={sending}
              placeholder="Type your reply… (Ctrl+Enter to send)"
              aria-label="Reply message"
              className={cn(
                'flex-1 resize-y rounded-[var(--radius-md)] border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-fg)] shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] disabled:opacity-60',
              )}
            />
            <LoadingButton
              loading={sending}
              disabled={reply.trim().length === 0}
              onClick={() => {
                void handleSend();
              }}
              size="default"
              className="self-end"
              aria-label="Send reply"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              Send
            </LoadingButton>
          </div>
          <p className="text-right text-xs text-[var(--color-muted)]">
            {reply.length}/{REPLY_MAX}
          </p>
        </div>
      )}
    </div>
  );
}
