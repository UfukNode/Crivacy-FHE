'use client';

import { useEffect, useCallback } from 'react';

/**
 * "Unsaved changes" guard on navigate/close.
 * Shows browser dialog when user tries to leave with dirty form.
 *
 * @param isDirty - Whether the form has unsaved changes
 * @param message - Warning message (only shown in some browsers)
 */
export function useUnsavedChanges(isDirty: boolean, message = 'You have unsaved changes. Leave anyway?') {
  const handleBeforeUnload = useCallback(
    (e: BeforeUnloadEvent) => {
      if (!isDirty) return;
      e.preventDefault();
      // Some browsers show custom message, most show generic
      e.returnValue = message;
      return message;
    },
    [isDirty, message],
  );

  useEffect(() => {
    if (!isDirty) return;
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty, handleBeforeUnload]);
}
