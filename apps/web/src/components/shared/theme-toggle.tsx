'use client';

import * as React from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useResolvedTheme } from '@/hooks/use-resolved-theme';

/**
 * Dark/light mode toggle.
 *
 * Initial theme is set BEFORE first paint by an inline script in <head>
 * (`apps/web/src/app/layout.tsx::themeInitScript`), that script reads
 * localStorage and `prefers-color-scheme` synchronously and stamps
 * `data-theme` onto `<html>`. This component only handles the toggle
 * action, sourcing the current value from `useResolvedTheme()` (the
 * canonical hook that observes the `data-theme` attribute).
 *
 * Toggle persists the explicit user choice ('light' | 'dark') in
 * localStorage so subsequent visits respect it. Choosing the same theme
 * the system already provides effectively pins it; clearing the entry
 * (e.g. via DevTools) reverts to system-preference auto-detect on the
 * next page load.
 */
export function ThemeToggle() {
  const theme = useResolvedTheme();

  const toggle = React.useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('crivacy-theme', next);
    } catch {
      // Privacy-mode browsers throw on storage writes, UI still updates
      // for this session, persistence simply degrades to none.
    }
  }, [theme]);

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {theme === 'dark' ? (
        <Sun className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Moon className="h-4 w-4" aria-hidden="true" />
      )}
    </Button>
  );
}
