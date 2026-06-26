"use client";

import { useCallback, useEffect, useRef } from "react";

// Minimal Turnstile JS API shape we use — see hero/modal usage. The full
// typing is upstream at @types/cloudflare-turnstile but declaring the few
// functions we call avoids a new dev dep just for these signatures.
declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement | string,
        opts: {
          sitekey: string;
          size?: "normal" | "compact" | "invisible" | "flexible";
          theme?: "light" | "dark" | "auto";
          appearance?: "always" | "execute" | "interaction-only";
          callback?: (token: string) => void;
          "error-callback"?: () => void;
          "expired-callback"?: () => void;
        },
      ) => string;
      execute: (widgetId: string) => void;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";

type UseTurnstileOpts = {
  // Whether the widget should be mounted right now. Useful for modal
  // containers that only render when `open=true` — we don't want to
  // mount the widget until the container exists in the DOM.
  enabled?: boolean;
};

// Mounts a Cloudflare Turnstile widget inside the given container ref and
// returns a `getToken()` function that the caller runs at submit time.
// The widget is mounted in `interaction-only` mode so the challenge UI
// only appears when Cloudflare deems the visitor suspicious — normal
// traffic gets a silent token.
//
// Usage:
//   const ref = useRef<HTMLDivElement>(null);
//   const { getToken } = useTurnstile(ref);
//   const onSubmit = async () => {
//     const token = await getToken();
//     if (!token) return showError();
//     fetch("/api/notify", { body: JSON.stringify({ email, token }) });
//   };
export function useTurnstile(
  containerRef: React.RefObject<HTMLDivElement | null>,
  { enabled = true }: UseTurnstileOpts = {},
) {
  const widgetIdRef = useRef<string | null>(null);
  const tokenResolverRef = useRef<((token: string) => void) | null>(null);

  useEffect(() => {
    if (!enabled || !TURNSTILE_SITE_KEY) return;

    let cancelled = false;

    const mount = () => {
      if (cancelled) return;
      if (
        !window.turnstile ||
        !containerRef.current ||
        widgetIdRef.current
      ) {
        return;
      }
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        size: "flexible",
        appearance: "interaction-only",
        theme: "auto",
        callback: (token: string) => {
          if (tokenResolverRef.current) {
            tokenResolverRef.current(token);
            tokenResolverRef.current = null;
          }
        },
        "error-callback": () => {
          if (tokenResolverRef.current) {
            tokenResolverRef.current("");
            tokenResolverRef.current = null;
          }
        },
        "expired-callback": () => {
          if (widgetIdRef.current && window.turnstile) {
            window.turnstile.reset(widgetIdRef.current);
          }
        },
      });
    };

    if (window.turnstile) {
      mount();
    }
    // Poll for `window.turnstile` in case the layout-level <Script> hasn't
    // finished parsing yet. Cleared on unmount to avoid dangling timers.
    const interval = window.setInterval(() => {
      if (window.turnstile && !widgetIdRef.current) {
        mount();
      }
      if (widgetIdRef.current) {
        window.clearInterval(interval);
      }
    }, 150);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [enabled, containerRef]);

  const getToken = useCallback((): Promise<string> => {
    return new Promise((resolve) => {
      if (!widgetIdRef.current || !window.turnstile) {
        resolve("");
        return;
      }
      tokenResolverRef.current = resolve;
      window.turnstile.reset(widgetIdRef.current);
      window.turnstile.execute(widgetIdRef.current);

      // Safety timeout — if Turnstile never resolves (network, CSP,
      // blocked hostname, etc.) we bail out after 15s so the caller's
      // UI doesn't stay on a spinner forever.
      window.setTimeout(() => {
        if (tokenResolverRef.current === resolve) {
          tokenResolverRef.current = null;
          resolve("");
        }
      }, 15000);
    });
  }, []);

  return { getToken };
}
