'use client';

import { useCallback, useEffect, useRef } from 'react';

/** Fields that must NEVER be persisted to storage */
const SENSITIVE_FIELDS = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'confirmPassword',
  'totpCode',
  'secret',
  'token',
]);

interface UseFormPersistenceOptions {
  /** Unique form identifier */
  formId: string;
  /** Current user ID (scoping) */
  userId?: string;
  /** Debounce delay in ms (default 500) */
  debounceMs?: number;
  /** TTL in ms (default 1 hour) */
  ttlMs?: number;
}

function getStorageKey(formId: string, userId?: string): string {
  return `form:${formId}${userId ? `:${userId}` : ''}`;
}

function stripSensitive(data: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!SENSITIVE_FIELDS.has(key)) {
      clean[key] = value;
    }
  }
  return clean;
}

/**
 * Save form state to sessionStorage (debounced, TTL 1h, excludes passwords).
 * Used for multi-step forms, ticket creation, etc.
 */
export function useFormPersistence<T extends Record<string, unknown>>({
  formId,
  userId,
  debounceMs = 500,
  ttlMs = 3600000, // 1 hour
}: UseFormPersistenceOptions) {
  const key = getStorageKey(formId, userId);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  /** Save form data (debounced) */
  const save = useCallback(
    (data: T) => {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        try {
          const payload = {
            data: stripSensitive(data as Record<string, unknown>),
            savedAt: Date.now(),
          };
          sessionStorage.setItem(key, JSON.stringify(payload));
        } catch {
          // sessionStorage full or unavailable — silently ignore
        }
      }, debounceMs);
    },
    [key, debounceMs],
  );

  /** Restore form data (returns null if expired or missing) */
  const restore = useCallback((): Partial<T> | null => {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const { data, savedAt } = JSON.parse(raw) as { data: Record<string, unknown>; savedAt: number };
      if (Date.now() - savedAt > ttlMs) {
        sessionStorage.removeItem(key);
        return null;
      }
      return data as Partial<T>;
    } catch {
      return null;
    }
  }, [key, ttlMs]);

  /** Clear persisted data (call on successful submit or explicit cancel) */
  const clear = useCallback(() => {
    clearTimeout(timeoutRef.current);
    try {
      sessionStorage.removeItem(key);
    } catch {
      // ignore
    }
  }, [key]);

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  return { save, restore, clear };
}
