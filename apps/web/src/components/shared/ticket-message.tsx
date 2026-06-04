'use client';

import { LoadingButton } from '@/components/shared/loading-button';
import { RelativeTime } from '@/components/shared/relative-time';
import { UserAvatar } from '@/components/shared/user-avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Check, CheckCheck, Lock, Pencil, X } from 'lucide-react';
import * as React from 'react';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Minimum shape every ticket message must provide so the shared component
 * can render it. Both the admin and customer message hooks expose exactly
 * these fields, anything extra (attachments, sender email, …) stays in
 * the caller's local types and is surfaced through `renderAttachments`.
 */
export interface TicketMessageData {
  readonly id: string;
  readonly senderId?: string | null;
  readonly senderType: string;
  readonly senderName: string | null;
  readonly body: string;
  readonly isInternal?: boolean;
  /**
   * `true` once any non-author has loaded the ticket detail. Drives
   * the WhatsApp-style read indicator on the author's own messages
   * AND the edit-lock (author may only edit while `false`).
   * Optional so system / legacy shapes still compile.
   */
  readonly seenByOther?: boolean;
  readonly createdAt: string;
}

const EDIT_MAX_LENGTH = 5000;

/* -------------------------------------------------------------------------- */
/*  Read indicator                                                            */
/* -------------------------------------------------------------------------- */

/**
 * WhatsApp-style read indicator shown on the author's own messages.
 * Single gray check = delivered (nobody else has opened the ticket).
 * Double accent-colored check = seen by at least one other participant.
 *
 * Intentionally does NOT surface *who* saw it, the project's
 * accountability model only requires "visible vs not" to lock edits.
 */
function ReadIndicator({ seenByOther }: { readonly seenByOther: boolean }) {
  const label = seenByOther ? 'Seen' : 'Sent, not yet seen';
  if (seenByOther) {
    return (
      <span
        className="inline-flex items-center text-[var(--color-accent)]"
        aria-label={label}
        title={label}
      >
        <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center text-[var(--color-muted)]"
      aria-label={label}
      title={label}
    >
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  System message                                                            */
/* -------------------------------------------------------------------------- */

interface TicketSystemMessageProps {
  readonly message: Pick<TicketMessageData, 'id' | 'body' | 'createdAt'>;
}

/**
 * Renders a system event (status change, assignment, …) as an inline rule
 * with a short descriptive label. Intentionally low visual weight so it
 * reads as meta-information rather than a conversational turn.
 */
export function TicketSystemMessage({ message }: TicketSystemMessageProps) {
  return (
    <output className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
      <p className="text-xs text-[var(--color-muted)]">
        {message.body}
        <span className="ml-2">
          <RelativeTime date={message.createdAt} />
        </span>
      </p>
      <div className="h-px flex-1 bg-[var(--color-border)]" aria-hidden="true" />
    </output>
  );
}

/* -------------------------------------------------------------------------- */
/*  Thread message                                                            */
/* -------------------------------------------------------------------------- */

interface TicketMessageProps {
  readonly message: TicketMessageData;
  /**
   * When provided and matches the message's sender id, the component marks
   * the sender as "you" so the viewer can tell their own messages apart
   * without relying on left/right bubble alignment.
   */
  readonly currentUserId?: string | null;
  /**
   * Optional renderer for inline attachments. The customer thread passes
   * a function that renders image previews; the admin thread omits it and
   * gets no attachment UI. Keeps attachment loading/preview logic out of
   * this shared component.
   */
  readonly renderAttachments?: () => React.ReactNode;
  /**
   * Optional edit submitter. When provided, the component renders a
   * pencil control on the viewer's own unread messages; clicking opens
   * an inline textarea and the new body is passed back via this
   * callback. The parent owns the network call.
   *
   * Return `true` to close the edit UI (success) or `false` to keep it
   * open (failure). Throwing is treated as failure.
   */
  readonly onEdit?: (messageId: string, newBody: string) => Promise<boolean>;
  /**
   * When `true`, the bubble briefly pulses with an accent ring, used
   * for deep-linking from email/notification (`?m=<id>`). Owned by the
   * parent page so the effect fires exactly once per navigation.
   */
  readonly highlight?: boolean;
}

/**
 * Renders a single ticket message in a linear thread/feed layout,
 * avatar + sender header on top, body below, optional attachments,
 * timestamp inline in the header. Used by both admin and customer ticket
 * detail pages.
 *
 * Visual variants:
 * - Regular message: surface-tinted card with neutral border.
 * - Current user's message: subtle accent-tinted background so "my"
 *   messages are easy to spot while scrolling. Author's own unread
 *   messages get a pencil control and a gray ✓; once the flag flips,
 *   the control is removed and the check turns accent-colored.
 * - Internal note (admin-only): warning-toned background + dashed border +
 *   explicit "Internal Note" pill. Customers never receive these.
 */
export function TicketMessage({
  message,
  currentUserId,
  renderAttachments,
  onEdit,
  highlight = false,
}: TicketMessageProps) {
  if (message.senderType === 'system') {
    return <TicketSystemMessage message={message} />;
  }

  const isInternal = message.isInternal === true;
  const isCustomer = message.senderType === 'customer';
  const isMe =
    currentUserId !== null &&
    currentUserId !== undefined &&
    message.senderId === currentUserId;
  const seenByOther = message.seenByOther === true;
  const canEdit = isMe && !seenByOther && onEdit !== undefined;

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(message.body);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // If the server flips `seen_by_other` between render passes (another
  // tab marks it read) we must abandon the edit, it will fail anyway.
  React.useEffect(() => {
    if (!canEdit && editing) {
      setEditing(false);
      setError(null);
    }
  }, [canEdit, editing]);

  const displayName = message.senderName ?? (isCustomer ? 'Customer' : 'Admin');
  const roleLabel = isCustomer ? 'Customer' : 'Support';
  // Fall back to the message id so the avatar always has a stable hash.
  const avatarId = message.senderId ?? message.id;

  async function handleSave(): Promise<void> {
    if (onEdit === undefined) return;
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setError('Message body cannot be empty.');
      return;
    }
    if (trimmed.length > EDIT_MAX_LENGTH) {
      setError(`Message must be at most ${EDIT_MAX_LENGTH} characters.`);
      return;
    }
    if (trimmed === message.body) {
      setEditing(false);
      setError(null);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const ok = await onEdit(message.id, trimmed);
      if (ok) {
        setEditing(false);
      }
    } catch {
      setError('Failed to save edit.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel(): void {
    setDraft(message.body);
    setEditing(false);
    setError(null);
  }

  // Chat-bubble alignment: the caller's own messages hug the right
  // edge, everyone else's hug the left. Two knobs control the layout:
  //
  //   1. An outer flex wrapper justifies the bubble.
  //   2. Header flexes right-to-left when `isMe` so the avatar sits
  //      on the side of the caller's own column.
  //
  // Text inside the bubble stays left-aligned (typical chat UX, only
  // the bubble position flips, not the reading direction).
  return (
    <div className={cn('flex w-full', isMe ? 'justify-end' : 'justify-start')}>
      <article
        id={`ticket-message-${message.id}`}
        className={cn(
          'group max-w-[85%] rounded-[var(--radius-md)] border px-4 py-3 transition-[box-shadow,background-color,border-color] duration-700',
          isInternal
            ? 'border-dashed border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10'
            : isMe
              ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5'
              : 'border-[var(--color-border)] bg-[var(--color-surface)]/40',
          // Deep-link highlight: accent ring + subtle glow that fades
          // back into the base bubble appearance once the parent flips
          // `highlight` to false (typically 2.5s after navigation).
          highlight &&
            'shadow-[0_0_0_3px_var(--color-accent)] ring-2 ring-[var(--color-accent)]',
        )}
        aria-label={`Message from ${displayName}`}
      >
      {/* Header, avatar + name flow from the caller's side. `flex-row-reverse`
          on `isMe` flips the row so the avatar lands on the right; the inner
          name/timestamp blocks still read left-to-right. */}
      <header
        className={cn(
          'flex items-start gap-3',
          isMe && 'flex-row-reverse',
        )}
      >
        <UserAvatar user={{ id: avatarId, displayName }} size="sm" />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'flex flex-wrap items-center gap-x-2 gap-y-0.5',
              isMe && 'justify-end',
            )}
          >
            <span className="text-sm font-medium text-[var(--color-fg)]">
              {displayName}
              {isMe && (
                <span className="ml-1 font-normal text-[var(--color-muted)]">(you)</span>
              )}
            </span>
            {/* Role label is redundant for:
                  - the caller's own messages ("(you)" already marks them)
                  - customer messages (the "customer" role is implicit
                    given we only have one customer per ticket)
                Show it only for OTHER admins so the viewer can tell
                "Support" from "Admin" from "Superadmin" at a glance. */}
            {!isMe && !isCustomer && (
              <span className="text-xs text-[var(--color-muted)]">{roleLabel}</span>
            )}
            {isInternal && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-warning)]/15 px-2 py-0.5 text-xs font-medium text-[var(--color-warning)]">
                <Lock className="h-3 w-3" aria-hidden="true" />
                Internal Note
              </span>
            )}
          </div>
          <p
            className={cn(
              'flex items-center gap-1.5 text-xs text-[var(--color-muted)]',
              isMe && 'justify-end',
            )}
          >
            <RelativeTime date={message.createdAt} />
            {isMe && message.seenByOther !== undefined && (
              <ReadIndicator seenByOther={seenByOther} />
            )}
          </p>
        </div>
        {canEdit && !editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(message.body);
              setEditing(true);
            }}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted)] opacity-0 transition-opacity hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] group-hover:opacity-100"
            aria-label="Edit message"
            title="Edit message"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </header>

      {/* Thin separator between header and body so the message content
          reads as a distinct section from the "who sent it" metadata.
          Inherits the bubble's horizontal padding (px-4) so the rule
          sits inside the border with a comfortable inset. */}
      <div
        className="my-2.5 border-t border-[var(--color-border)]/60"
        aria-hidden="true"
      />

      {/* Body, gutter padding follows the avatar side: left for others, right
          for self, so body text lines up under the name in both orientations. */}
      <div className={cn(isMe ? 'pr-11' : 'pl-11')}>
        {editing ? (
          <div className="space-y-2">
            {error !== null && (
              <div
                role="alert"
                className="rounded-[var(--radius-sm)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2.5 py-1.5 text-xs text-[var(--color-danger)]"
              >
                {error}
              </div>
            )}
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
              maxLength={EDIT_MAX_LENGTH}
              rows={Math.max(3, Math.min(10, draft.split('\n').length + 1))}
              disabled={submitting}
              aria-label="Edit message body"
              className="w-full resize-y rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-transparent px-2.5 py-1.5 text-sm text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring-color)] disabled:opacity-60"
            />
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-xs text-[var(--color-muted)]">
                {draft.length}/{EDIT_MAX_LENGTH}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                disabled={submitting}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                Cancel
              </Button>
              <LoadingButton
                size="sm"
                loading={submitting}
                onClick={() => {
                  void handleSave();
                }}
              >
                Save
              </LoadingButton>
            </div>
          </div>
        ) : (
          <>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--color-fg)]">
              {message.body}
            </p>
            {renderAttachments && <div className="mt-3">{renderAttachments()}</div>}
          </>
        )}
      </div>
      </article>
    </div>
  );
}
