'use client';

import { useEffect, useRef } from 'react';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type KycEventType =
  | 'kyc.status_changed'
  | 'kyc.step_completed'
  | 'kyc.handoff_consumed'
  | 'credential.issued';
type KycEventHandler = (event: KycEventType, data: unknown) => void;

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** SSE endpoint for real-time KYC updates. */
const SSE_URL = '/api/customer/kyc/events';

/** Reconnect delay after an SSE connection error (ms). */
const RECONNECT_DELAY_MS = 5000;

/** All event types the SSE stream may emit. */
const EVENT_TYPES: readonly KycEventType[] = [
  'kyc.status_changed',
  'kyc.step_completed',
  'kyc.handoff_consumed',
  'credential.issued',
] as const;

/* -------------------------------------------------------------------------- */
/*  Hook                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Subscribe to the KYC Server-Sent Events stream.
 *
 * Connects to `/api/customer/kyc/events`, listens for typed events, and
 * calls `onEvent` whenever one arrives.  Automatically reconnects after
 * connection errors with a 5-second delay.
 *
 * @param onEvent  Callback invoked with the event type and parsed JSON payload.
 * @param enabled  Pass `false` to suspend the connection (e.g. when the user
 *                 is not on a KYC-related page).
 */
export function useKycEvents(onEvent: KycEventHandler, enabled = true) {
  // Keep the latest handler in a ref so the effect's listener closures
  // always call the current callback without re-subscribing.
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;

    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    function connect() {
      if (disposed) return;

      eventSource = new EventSource(SSE_URL, { withCredentials: true });

      for (const eventType of EVENT_TYPES) {
        eventSource.addEventListener(eventType, (e: MessageEvent) => {
          try {
            const data: unknown = JSON.parse(e.data as string);
            handlerRef.current(eventType, data);
          } catch {
            // Silently ignore malformed JSON payloads.
          }
        });
      }

      eventSource.onerror = () => {
        eventSource?.close();
        if (!disposed) {
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      eventSource?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [enabled]);
}

export type { KycEventType, KycEventHandler };
