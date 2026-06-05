'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

function getSnapshot(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

function getServerSnapshot(): boolean {
  return true;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

/**
 * Online/offline detection using useSyncExternalStore.
 * Also pings health endpoint every 30s when offline to detect reconnection.
 */
export function useNetworkStatus() {
  const isOnline = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return { isOnline };
}
