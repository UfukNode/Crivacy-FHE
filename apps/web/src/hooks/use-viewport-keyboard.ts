'use client';

import { useEffect, useState } from 'react';

/**
 * Detects virtual keyboard on mobile via visualViewport API.
 * When keyboard opens, viewport height shrinks. Use this to scroll inputs into view.
 */
export function useViewportKeyboard() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const onResize = () => {
      const heightDiff = window.innerHeight - viewport.height;
      setKeyboardHeight(Math.max(0, heightDiff));
    };

    viewport.addEventListener('resize', onResize);
    viewport.addEventListener('scroll', onResize);

    return () => {
      viewport.removeEventListener('resize', onResize);
      viewport.removeEventListener('scroll', onResize);
    };
  }, []);

  return {
    keyboardHeight,
    isKeyboardOpen: keyboardHeight > 100,
  };
}
