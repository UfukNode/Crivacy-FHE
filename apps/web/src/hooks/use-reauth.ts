'use client';

import { useCallback, useRef, useState } from 'react';

const GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Re-authentication gate for sensitive actions.
 * After verification, grants a 5-minute grace period (in-memory only, not persisted).
 *
 * Provides a `verifyPassword` function that calls the backend
 * `POST /api/customer/auth/verify-password` endpoint. The ReauthDialog
 * component passes this as the `onVerify` prop.
 */
export function useReauth() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const lastVerifiedAt = useRef<number>(0);
  const pendingCallback = useRef<(() => void) | null>(null);

  /**
   * Check if recently authenticated. If yes, execute callback.
   * If no, open reauth dialog. After verification, execute callback.
   */
  const requireReauth = useCallback((callback: () => void) => {
    const now = Date.now();
    if (now - lastVerifiedAt.current < GRACE_PERIOD_MS) {
      callback();
      return;
    }
    pendingCallback.current = callback;
    setIsDialogOpen(true);
  }, []);

  const onSuccess = useCallback(() => {
    lastVerifiedAt.current = Date.now();
    pendingCallback.current?.();
    pendingCallback.current = null;
  }, []);

  /**
   * Call the backend verify-password endpoint.
   * Throws on failure so the ReauthDialog can catch and display errors.
   */
  const verifyPassword = useCallback(async (password: string): Promise<void> => {
    const res = await fetch('/api/customer/auth/verify-password', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      const message = body?.error?.message ?? 'Verification failed.';
      throw new Error(message);
    }
  }, []);

  return {
    isDialogOpen,
    setIsDialogOpen,
    requireReauth,
    onSuccess,
    verifyPassword,
  };
}
