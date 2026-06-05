'use client';

import * as React from 'react';

const HIGHLIGHT_DURATION_MS = 2500;

/**
 * Shared deep-link highlight hook for both the customer and admin
 * ticket detail pages.
 *
 * When `?m=<messageId>` is present in the URL and the corresponding
 * message exists in the loaded thread, the hook:
 *
 *   1. Scrolls the target element into the viewport (centred).
 *   2. Flips the returned `highlightedId` to that id for
 *      {@link HIGHLIGHT_DURATION_MS} so the page can apply a temporary
 *      ring on the matching bubble.
 *   3. Remembers which id it already handled so incoming live data
 *      (SWR revalidation, new messages arriving) does NOT re-trigger
 *      the scroll or flash again.
 *
 * Navigating to a new `?m=...` value (e.g. clicking a second
 * notification while already on the page) resets the guard and
 * re-highlights the new target.
 *
 * @param rawMessageId Current `m` query parameter (or null).
 * @param isReady      `true` once the thread data has loaded.
 * @param messageIds   IDs of messages currently rendered — used to
 *                     confirm the target exists before scrolling.
 * @returns `{ highlightedId }` — pass `highlight={highlightedId === msg.id}`
 *          to `<TicketMessage>`.
 */
export function useHighlightMessageOnMount(
  rawMessageId: string | null,
  isReady: boolean,
  messageIds: readonly string[],
): { readonly highlightedId: string | null } {
  const [highlightedId, setHighlightedId] = React.useState<string | null>(null);
  const handledRef = React.useRef<string | null>(null);

  // Gate on a stable key (comma-joined ids is cheaper than hashing and
  // changes whenever the thread length / ordering changes — which is
  // exactly when we want to retry if the target message arrived late).
  const idListKey = messageIds.join(',');

  React.useEffect(() => {
    if (!isReady) return;
    if (rawMessageId === null || rawMessageId.length === 0) return;

    // Already handled this id — ignore follow-up data refreshes.
    if (handledRef.current === rawMessageId) return;

    // Only fire when the target is actually present in the current set.
    if (!messageIds.includes(rawMessageId)) return;

    const element = document.getElementById(`ticket-message-${rawMessageId}`);
    if (element === null) return;

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedId(rawMessageId);
    handledRef.current = rawMessageId;

    const timer = window.setTimeout(() => {
      setHighlightedId((current) => (current === rawMessageId ? null : current));
    }, HIGHLIGHT_DURATION_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [rawMessageId, isReady, idListKey, messageIds]);

  return { highlightedId };
}
