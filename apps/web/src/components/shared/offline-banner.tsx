'use client';

import * as React from 'react';
import { WifiOff, Wifi } from 'lucide-react';
import { useNetworkStatus } from '@/hooks/use-network-status';
import { cn } from '@/lib/utils';

/**
 * Sticky offline/online notification banner.
 * Yellow: "You're offline". Auto-dismisses when back online with green "Back online" for 3s.
 */
export function OfflineBanner() {
  const { isOnline } = useNetworkStatus();
  const [showReconnected, setShowReconnected] = React.useState(false);
  const wasOfflineRef = React.useRef(false);

  React.useEffect(() => {
    if (!isOnline) {
      wasOfflineRef.current = true;
      setShowReconnected(false);
      return;
    }
    if (wasOfflineRef.current) {
      wasOfflineRef.current = false;
      setShowReconnected(true);
      const timer = setTimeout(() => setShowReconnected(false), 3000);
      return () => clearTimeout(timer);
    }
    return;
  }, [isOnline]);

  if (isOnline && !showReconnected) return null;

  return (
    <div
      className={cn(
        'fixed left-0 right-0 top-0 z-[60] flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium safe-top',
        !isOnline && 'bg-[var(--color-warning)] text-black',
        showReconnected && 'bg-[var(--color-success)] text-white',
      )}
      role="alert"
    >
      {!isOnline ? (
        <>
          <WifiOff className="h-4 w-4" aria-hidden="true" />
          You&apos;re offline. Changes will sync when reconnected.
        </>
      ) : (
        <>
          <Wifi className="h-4 w-4" aria-hidden="true" />
          Back online
        </>
      )}
    </div>
  );
}
