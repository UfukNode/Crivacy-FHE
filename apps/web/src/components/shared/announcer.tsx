'use client';

import * as React from 'react';

interface AnnouncerContextType {
  announce: (message: string) => void;
}

const AnnouncerContext = React.createContext<AnnouncerContextType | null>(null);

/**
 * ARIA live region for screen reader announcements.
 * Announces: form submissions, toast messages, navigation changes, table sort changes.
 */
export function AnnouncerProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = React.useState('');
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  const announce = React.useCallback((msg: string) => {
    // Clear and re-set to force re-announcement of identical messages
    setMessage('');
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setMessage(msg), 100);
  }, []);

  React.useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  const contextValue = React.useMemo(() => ({ announce }), [announce]);

  return (
    <AnnouncerContext.Provider value={contextValue}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {message}
      </div>
    </AnnouncerContext.Provider>
  );
}

/**
 * Hook to announce messages to screen readers.
 * @returns announce(message) function
 */
export function useAnnouncer() {
  const context = React.useContext(AnnouncerContext);
  if (!context) {
    throw new Error('useAnnouncer must be used within AnnouncerProvider');
  }
  return context;
}
