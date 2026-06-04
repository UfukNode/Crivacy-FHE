'use client';

import * as React from 'react';
import { SWRConfig } from 'swr';
import { Toaster } from 'sonner';
import { swrConfig } from '@/lib/swr-config';
import { AnnouncerProvider } from '@/components/shared/announcer';
import { OfflineBanner } from '@/components/shared/offline-banner';
import { useResolvedTheme } from '@/hooks/use-resolved-theme';

/**
 * Root providers wrapper.
 * Provides: SWR data fetching, toast notifications, ARIA announcer, offline detection.
 * Must be a client component since SWRConfig uses React context.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const resolvedTheme = useResolvedTheme();
  return (
    <SWRConfig value={swrConfig}>
      <AnnouncerProvider>
        {children}
        <OfflineBanner />
        <Toaster
          position="bottom-right"
          theme={resolvedTheme}
          toastOptions={{
            style: {
              background: 'var(--color-surface)',
              color: 'var(--color-fg)',
              border: '1px solid var(--color-border)',
            },
          }}
          closeButton
        />
      </AnnouncerProvider>
    </SWRConfig>
  );
}
