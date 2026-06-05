'use client';

import { useCallback, useRef, useEffect } from 'react';

/**
 * Debounce wrapper for callbacks.
 * Used for form submissions, search input handlers, etc.
 * Cancels pending call on unmount.
 */
export function useDebouncedCallback<T extends (...args: unknown[]) => unknown>(
  callback: T,
  delayMs: number,
): T {
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const callbackRef = useRef(callback);

  // Always use the latest callback
  callbackRef.current = callback;

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  return useCallback(
    ((...args: unknown[]) => {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => callbackRef.current(...args), delayMs);
    }) as T,
    [delayMs],
  );
}
