'use client';

import { useEffect, useState } from 'react';

/**
 * Read the current `data-theme` value off `<html>` and stay in sync with
 * any subsequent attribute mutations. The pre-paint script in
 * `apps/web/src/app/layout.tsx` is the single source of truth for the
 * initial value (synchronous, runs before first paint, eliminates FOWT);
 * this hook is the React-side mirror so components can re-render when
 * the toggle flips the attribute.
 *
 * Why MutationObserver and not a context provider: the attribute is
 * already the canonical state — every CSS rule keys off it directly via
 * `[data-theme='light'] { ... }`. Mirroring it through a Provider would
 * just duplicate state and create a second source that could drift from
 * the DOM (e.g. if a future feature flips `data-theme` from a non-React
 * code path like browser sync). Observing the attribute keeps React in
 * lock-step with whatever is on `<html>` right now.
 *
 * Initial state for SSR is `'dark'`. Servers can't read localStorage or
 * the user's system preference, so any default is technically a guess —
 * but the inline script overrides this within the same paint, so the
 * mismatch never reaches the screen. The `suppressHydrationWarning` on
 * `<html>` documents this expected SSR/client divergence.
 */
export function useResolvedTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const read = () => {
      const current = document.documentElement.getAttribute('data-theme');
      setTheme(current === 'light' ? 'light' : 'dark');
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}
