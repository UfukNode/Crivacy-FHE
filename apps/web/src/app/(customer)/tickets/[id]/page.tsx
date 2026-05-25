'use client';

import { LoadingButton } from '@/components/shared/loading-button';
import { RelativeTime } from '@/components/shared/relative-time';
import { TicketMessage } from '@/components/shared/ticket-message';
import { TicketPriorityBadge } from '@/components/shared/ticket-priority-badge';
import { TicketStatusBadge } from '@/components/shared/ticket-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useCustomerProfile } from '@/hooks/use-customer-profile';
import { useHighlightMessageOnMount } from '@/hooks/use-highlight-message-on-mount';
import { type TicketAttachment, useTicketDetail } from '@/hooks/use-ticket-detail';
import { cn } from '@/lib/utils';
import { ArrowLeft, ImageIcon, Loader2, Paperclip, Send, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const REPLY_MAX_LENGTH = 5000;

/* -------------------------------------------------------------------------- */
/*  Loading skeleton                                                          */
/* -------------------------------------------------------------------------- */

function TicketDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32" />
      <div className="space-y-3">
        <Skeleton className="h-20" />
        <Skeleton className="ml-auto h-20 w-3/4" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-32" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Inline attachment display                                                 */
/* -------------------------------------------------------------------------- */

interface AttachmentImageProps {
  readonly attachment: TicketAttachment;
}

function AttachmentImage({ attachment }: AttachmentImageProps) {
  const [loaded, setLoaded] = React.useState(false);
  const [imgError, setImgError] = React.useState(false);

  if (imgError) {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <ImageIcon className="h-4 w-4 text-[var(--color-muted)]" aria-hidden="true" />
        <span className="text-xs text-[var(--color-muted)]">{attachment.originalFilename}</span>
      </div>
    );
  }

  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative mt-2 block overflow-hidden rounded-[var(--radius-md)]"
      aria-label={`View attachment: ${attachment.originalFilename}`}
    >
      {!loaded && (
        <div className="flex h-32 items-center justify-center bg-[var(--color-surface)]">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--color-muted)]" aria-hidden="true" />
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={attachment.url}
        alt={attachment.originalFilename}
        width={attachment.width ?? undefined}
        height={attachment.height ?? undefined}
        className={cn(
          'max-h-64 max-w-full rounded-[var(--radius-md)] object-contain transition-opacity',
          loaded ? 'opacity-100' : 'h-0 opacity-0',
        )}
        onLoad={() => { setLoaded(true); }}
        onError={() => { setImgError(true); }}
      />
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/*  Reply form                                                                */
/* -------------------------------------------------------------------------- */

interface ReplyFormProps {
  readonly ticketId: string;
  readonly ticketStatus: string;
  readonly onReplySent: () => void;
}

interface PendingAttachment {
  readonly file: File;
  readonly preview: string;
}

interface UploadedAttachmentResponse {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly url: string;
}

function ReplyForm({ ticketId, ticketStatus, onReplySent }: ReplyFormProps) {
  const [reply, setReply] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingAttachment, setPendingAttachment] = React.useState<PendingAttachment | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const isClosed = ticketStatus === 'closed' || ticketStatus === 'resolved';

  // Clean up object URLs on unmount
  React.useEffect(() => {
    return () => {
      if (pendingAttachment) {
        URL.revokeObjectURL(pendingAttachment.preview);
      }
    };
  }, [pendingAttachment]);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so same file can be re-selected
    e.target.value = '';

    // Client-side validation
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      setError('File size must not exceed 5 MB.');
      return;
    }

    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!allowedTypes.has(file.type)) {
      setError('Only JPEG, PNG, and WebP images are allowed.');
      return;
    }

    // Revoke previous preview URL
    if (pendingAttachment) {
      URL.revokeObjectURL(pendingAttachment.preview);
    }

    setPendingAttachment({
      file,
      preview: URL.createObjectURL(file),
    });
    setError(null);
  }

  function removePendingAttachment() {
    if (pendingAttachment) {
      URL.revokeObjectURL(pendingAttachment.preview);
      setPendingAttachment(null);
    }
  }

  async function uploadAttachment(messageId: string): Promise<UploadedAttachmentResponse | null> {
    if (!pendingAttachment) return null;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', pendingAttachment.file);

      const res = await fetch(
        `/api/customer/tickets/${ticketId}/messages/${messageId}/attachments`,
        {
          method: 'POST',
          credentials: 'include',
          body: formData,
        },
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = body['error'] as Record<string, unknown> | undefined;
        const errMsg = (err?.['message'] as string | undefined) ?? 'Failed to upload attachment.';
        toast.error(errMsg);
        return null;
      }

      return (await res.json()) as UploadedAttachmentResponse;
    } catch {
      toast.error('Failed to upload attachment. Please try again.');
      return null;
    } finally {
      setUploading(false);
    }
  }

  async function handleSend() {
    const trimmed = reply.trim();
    if (!trimmed && !pendingAttachment) return;

    if (trimmed.length > REPLY_MAX_LENGTH) {
      setError(`Reply must be at most ${REPLY_MAX_LENGTH} characters.`);
      return;
    }

    setSending(true);
    setError(null);

    try {
      const messageText = trimmed.length > 0
        ? trimmed
        : (pendingAttachment ? '[Attachment]' : '');

      const res = await fetch(`/api/customer/tickets/${ticketId}/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: messageText }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const err = body['error'] as Record<string, unknown> | undefined;
        setError((err?.['message'] as string | undefined) ?? 'Failed to send reply.');
        return;
      }

      // If there's a pending attachment, upload it after message creation
      if (pendingAttachment) {
        // Extract message id from the response if available, or fetch the latest
        // The message API returns { success: true }, so we need the message id
        // We'll use the ticket id and rely on the backend to find the latest message
        // Actually, we need the message ID. Let's refetch to get the latest message.
        const detailRes = await fetch(`/api/customer/tickets/${ticketId}`, {
          credentials: 'include',
        });
        if (detailRes.ok) {
          const detailData = (await detailRes.json()) as {
            messages: readonly { id: string }[];
          };
          const msgs = detailData.messages;
          const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
          if (lastMsg) {
            await uploadAttachment(lastMsg.id);
          }
        }
        removePendingAttachment();
      }

      setReply('');
      onReplySent();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Ctrl+Enter or Cmd+Enter to send
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend();
    }
  }

  if (isClosed) {
    return (
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-center">
        <p className="text-sm text-[var(--color-muted)]">
          This ticket is {ticketStatus}. You cannot reply to it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error !== null && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {/* Pending attachment preview */}
      {pendingAttachment && (
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={pendingAttachment.preview}
            alt="Attachment preview"
            className="h-12 w-12 rounded-[var(--radius-sm)] object-cover"
          />
          <span className="flex-1 truncate text-sm text-[var(--color-fg)]">
            {pendingAttachment.file.name}
          </span>
          <span className="text-xs text-[var(--color-muted)]">
            {(pendingAttachment.file.size / 1024).toFixed(0)} KB
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={removePendingAttachment}
            aria-label="Remove attachment"
            disabled={sending || uploading}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      )}

      <div className="flex gap-2">
        <textarea
          value={reply}
          onChange={(e) => { setReply(e.target.value); }}
          onKeyDown={handleKeyDown}
          maxLength={REPLY_MAX_LENGTH}
          rows={3}
          placeholder="Type your reply... (Ctrl+Enter to send)"
          disabled={sending || uploading}
          aria-label="Reply message"
          className={cn(
            'flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-transparent px-3 py-2 text-base sm:text-sm text-[var(--color-fg)] shadow-[var(--shadow-sm)] transition-colors duration-[var(--duration-base)] placeholder:text-[var(--color-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-50 resize-y',
          )}
        />
        <div className="flex flex-col justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            onClick={() => { fileInputRef.current?.click(); }}
            disabled={sending || uploading}
            aria-label="Attach image"
          >
            <Paperclip className="h-4 w-4" aria-hidden="true" />
          </Button>
          <LoadingButton
            loading={sending || uploading}
            onClick={() => { void handleSend(); }}
            disabled={!reply.trim() && !pendingAttachment}
            size="default"
            aria-label="Send reply"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            Send
          </LoadingButton>
        </div>
      </div>

      {/* Hidden file input for attachment */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleFileSelect}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
      />

      <p className="text-xs text-[var(--color-muted)]">
        {reply.length}/{REPLY_MAX_LENGTH} characters
        {pendingAttachment && ' \u00b7 1 attachment'}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Customer ticket detail page.
 *
 * Shows the ticket header (reference, subject, status, priority),
 * a chronological message thread with chat-bubble styling
 * (customer messages right-aligned, admin/system messages left-aligned),
 * and a reply form at the bottom.
 */
export default function TicketDetailPage() {
  const params = useParams();
  const rawId = params?.['id'];
  const ticketId = typeof rawId === 'string' ? rawId : null;
  const { detail, error, isLoading, mutate } = useTicketDetail(ticketId);
  const { profile } = useCustomerProfile();
  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  const handleMessageEdit = React.useCallback(
    async (messageId: string, newBody: string): Promise<boolean> => {
      if (ticketId === null) return false;
      const res = await fetch(`/api/customer/tickets/${ticketId}/messages/${messageId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: newBody }),
      });
      if (!res.ok) return false;
      await mutate();
      return true;
    },
    [mutate, ticketId],
  );

  // `?m=<id>` deep-link (email / notification link), see the admin
  // page for the rationale. Auto-scroll-to-bottom is skipped when a
  // deep-link is in play so the scroll-into-view call below wins.
  const searchParams = useSearchParams();
  const deepLinkMessageId = (searchParams?.get('m') ?? null);
  const messageIds = React.useMemo(
    () => detail?.messages.map((m) => m.id) ?? [],
    [detail?.messages],
  );
  const { highlightedId } = useHighlightMessageOnMount(
    deepLinkMessageId,
    detail !== null && detail !== undefined,
    messageIds,
  );

  // Auto-scroll to the latest message on load and after reply, suppressed
  // when the URL targets a specific message.
  React.useEffect(() => {
    if (deepLinkMessageId !== null && deepLinkMessageId.length > 0) return;
    if (detail?.messages && detail.messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [detail?.messages, deepLinkMessageId]);

  if (isLoading) {
    return <TicketDetailSkeleton />;
  }

  if (error || !detail) {
    const status = (error as { status?: number } | undefined)?.status;
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/tickets">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to Tickets
          </Link>
        </Button>
        <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 p-4">
          <p className="text-sm text-[var(--color-danger)]">
            {status === 404
              ? 'Ticket not found. It may have been deleted.'
              : 'Failed to load ticket. Please try again.'}
          </p>
          {status !== 404 && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => { void mutate(); }}
            >
              Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  const { ticket, messages } = detail;

  return (
    <div className="space-y-6">
      {/* Back button */}
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/tickets">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Tickets
        </Link>
      </Button>

      {/* Ticket header card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-[var(--color-muted)]">
              {ticket.referenceNumber}
            </span>
            <TicketStatusBadge status={ticket.status} />
            <TicketPriorityBadge priority={ticket.priority} />
          </div>
          <CardTitle className="mt-1 text-lg">{ticket.subject}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-muted)]">
            <span>{ticket.categoryName}</span>
            <span aria-hidden="true">&middot;</span>
            <span>
              Created <RelativeTime date={ticket.createdAt} />
            </span>
            {ticket.updatedAt !== ticket.createdAt && (
              <>
                <span aria-hidden="true">&middot;</span>
                <span>
                  Updated <RelativeTime date={ticket.updatedAt} />
                </span>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Messages thread */}
      <section aria-label="Ticket conversation" className="space-y-3">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--color-muted)]">
            No messages yet.
          </p>
        ) : (
          messages.map((msg) => {
            const attachments = msg.attachments ?? [];
            // Only pass `renderAttachments` when there are attachments, with
            // `exactOptionalPropertyTypes` we can't pass `undefined` for an
            // optional prop, so we omit it entirely instead.
            const attachmentProp =
              attachments.length > 0
                ? {
                    renderAttachments: () => (
                      <div className="space-y-2">
                        {attachments.map((att) => (
                          <AttachmentImage key={att.id} attachment={att} />
                        ))}
                      </div>
                    ),
                  }
                : {};
            return (
              <TicketMessage
                key={msg.id}
                message={msg}
                currentUserId={profile?.id ?? null}
                onEdit={handleMessageEdit}
                highlight={highlightedId === msg.id}
                {...attachmentProp}
              />
            );
          })
        )}
        <div ref={messagesEndRef} aria-hidden="true" />
      </section>

      {/* Reply form */}
      <ReplyForm
        ticketId={ticket.id}
        ticketStatus={ticket.status}
        onReplySent={() => { void mutate(); }}
      />
    </div>
  );
}
