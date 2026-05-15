/**
 * Server-Sent Events helper for Next.js App Router.
 * Creates a ReadableStream that sends SSE-formatted events.
 *
 * SSE wire format (https://html.spec.whatwg.org/multipage/server-sent-events.html):
 *
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 *
 * Heartbeat is a comment line that keeps the TCP connection alive through
 * proxies and load balancers that drop idle connections:
 *
 *   : heartbeat\n
 *   \n
 */

export interface SSEWriter {
  /** Send a named event with JSON data. */
  readonly sendEvent: (event: string, data: unknown) => void;
  /** Send a heartbeat comment to keep the connection alive. */
  readonly sendHeartbeat: () => void;
  /** Close the stream gracefully. */
  readonly close: () => void;
}

export interface SSEStreamResult {
  readonly response: Response;
  readonly writer: SSEWriter;
}

export interface SSEStreamOptions {
  /** Optional additional headers merged into the response. */
  readonly headers?: Record<string, string>;
  /**
   * Callback fired exactly once when the stream is torn down —
   * either because the client disconnected (TCP RST / FIN), the
   * server called `writer.close()`, or a write failed because the
   * controller was already gone. Use this hook to decrement any
   * per-caller accounting (connection counters, active-request
   * maps) so slots free up the instant the underlying socket does.
   */
  readonly onCancel?: () => void;
}

/**
 * Create an SSE stream. Returns a `Response` to send to the client and a
 * `writer` object to push events from server-side code.
 *
 * Usage:
 * ```ts
 * export async function GET() {
 *   const { response, writer } = createSSEStream();
 *
 *   // In a background loop or event handler:
 *   writer.sendEvent('kyc.status_changed', { status: 'approved' });
 *
 *   // Periodically (e.g. every 30 s):
 *   writer.sendHeartbeat();
 *
 *   // When done:
 *   writer.close();
 *
 *   return response;
 * }
 * ```
 *
 * @param headers - Optional additional headers merged into the response.
 */
export function createSSEStream(
  headersOrOptions?: Record<string, string> | SSEStreamOptions,
): SSEStreamResult {
  // Backwards-compatible overload: old call sites passed a bare
  // `headers` record. Detect the new options shape by the presence
  // of the opt-in `onCancel` / `headers` keys; anything else is
  // treated as the legacy headers map.
  const options: SSEStreamOptions = (() => {
    if (headersOrOptions === undefined) return {};
    if ('headers' in headersOrOptions || 'onCancel' in headersOrOptions) {
      return headersOrOptions;
    }
    return { headers: headersOrOptions as Record<string, string> };
  })();

  const encoder = new TextEncoder();

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelled = false;

  /**
   * Fire `onCancel` at most once. Called from every teardown path —
   * client disconnect (ReadableStream.cancel), server close, write
   * failure mid-stream — so counters the caller attached stay
   * balanced regardless of which side won the race.
   */
  function fireCancel(): void {
    if (cancelled) return;
    cancelled = true;
    if (options.onCancel !== undefined) {
      try {
        options.onCancel();
      } catch {
        // A throwing teardown hook must not take the response with
        // it; swallow and move on.
      }
    }
  }

  const readable = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
    cancel() {
      // Client disconnected — clean up the controller reference so
      // subsequent writes are silently dropped instead of throwing,
      // then run the caller's teardown hook so per-connection
      // accounting releases its slot.
      controller = null;
      fireCancel();
    },
  });

  /**
   * Safely enqueue encoded text into the stream. If the controller is gone
   * (client disconnected or stream closed) the call is a no-op.
   */
  function enqueue(text: string): void {
    if (controller === null) {
      return;
    }
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      // Stream already closed — swallow the error and release the
      // caller's slot since the socket is effectively gone.
      controller = null;
      fireCancel();
    }
  }

  const writer: SSEWriter = {
    sendEvent(event: string, data: unknown): void {
      const json = JSON.stringify(data);
      enqueue(`event: ${event}\ndata: ${json}\n\n`);
    },

    sendHeartbeat(): void {
      enqueue(': heartbeat\n\n');
    },

    close(): void {
      if (controller === null) {
        fireCancel();
        return;
      }
      try {
        controller.close();
      } catch {
        // Already closed — ignore.
      }
      controller = null;
      fireCancel();
    },
  };

  const responseHeaders: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable Nginx buffering for SSE
    ...(options.headers ?? {}),
  };

  const response = new Response(readable, { headers: responseHeaders });

  return { response, writer };
}
