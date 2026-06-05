'use client';

import { useEffect, useRef } from 'react';

interface ShortcutDefinition {
  /** Key combo: 'mod+k' (Cmd/Ctrl+K), 'g h' (sequence), 'escape' */
  key: string;
  handler: () => void;
  /** Disabled when focus is in input/textarea (default true) */
  ignoreInInput?: boolean;
}

const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  if (INPUT_TAGS.has(el.tagName)) return true;
  if ((el as HTMLElement).contentEditable === 'true') return true;
  return false;
}

function normalizeKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

/**
 * Global keyboard shortcut handler.
 * Supports single key, modifier combos (mod+k), and sequences (g h).
 * Automatically disabled in input/textarea fields.
 */
export function useKeyboardShortcuts(shortcuts: ShortcutDefinition[]) {
  const sequenceBuffer = useRef<string>('');
  const sequenceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const normalized = normalizeKey(e);

      for (const shortcut of shortcuts) {
        const ignoreInInput = shortcut.ignoreInInput ?? true;
        if (ignoreInInput && isInputFocused()) continue;

        // Modifier combo: "mod+k"
        if (!shortcut.key.includes(' ') && shortcut.key === normalized) {
          e.preventDefault();
          shortcut.handler();
          sequenceBuffer.current = '';
          return;
        }
      }

      // Don't process sequences in inputs
      if (isInputFocused()) return;

      // Sequence handling: "g h"
      const key = e.key.toLowerCase();
      // Skip modifier keys themselves
      if (['control', 'meta', 'shift', 'alt'].includes(key)) return;

      const current = sequenceBuffer.current
        ? `${sequenceBuffer.current} ${key}`
        : key;

      for (const shortcut of shortcuts) {
        if (!shortcut.key.includes(' ')) continue;
        if (current === shortcut.key) {
          e.preventDefault();
          shortcut.handler();
          sequenceBuffer.current = '';
          clearTimeout(sequenceTimer.current);
          return;
        }
      }

      // Check if current is a valid prefix of any sequence
      const isPrefix = shortcuts.some(
        (s) => s.key.includes(' ') && s.key.startsWith(current + ' '),
      );
      if (isPrefix) {
        sequenceBuffer.current = current;
        clearTimeout(sequenceTimer.current);
        sequenceTimer.current = setTimeout(() => {
          sequenceBuffer.current = '';
        }, 1000);
      } else {
        // Check if this single key starts any sequence
        const startsSequence = shortcuts.some(
          (s) => s.key.includes(' ') && s.key.startsWith(key + ' '),
        );
        if (startsSequence) {
          sequenceBuffer.current = key;
          clearTimeout(sequenceTimer.current);
          sequenceTimer.current = setTimeout(() => {
            sequenceBuffer.current = '';
          }, 1000);
        } else {
          sequenceBuffer.current = '';
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(sequenceTimer.current);
    };
  }, [shortcuts]);
}
