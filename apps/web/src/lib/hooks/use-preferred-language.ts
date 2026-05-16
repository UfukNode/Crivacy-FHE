'use client';

/**
 * Shared language preference for multi-language code blocks.
 *
 * When the user clicks a language tab in any `MultiLangSnippet` block,
 * every other block on the page (and on subsequent visits) switches
 * to the same language. Without this, the install block could show
 * PHP while the init block sat on JS and the user had to re-click on
 * each one.
 *
 * Persisted in `localStorage` so the choice survives reloads, and
 * synchronised within the same browser tab via a custom event
 * (the native `storage` event only fires for OTHER tabs).
 *
 * @module
 */

import { useEffect, useState } from 'react';

import { LANGUAGES, type LanguageId } from '@/lib/integration/sdk-registry';

const STORAGE_KEY = 'crivacy.docs.preferred-lang';
const CHANGE_EVENT = 'crivacy:preferred-lang-changed';

function readStoredLanguage(): LanguageId | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    if (LANGUAGES.find((l) => l.id === raw) !== undefined) {
      return raw as LanguageId;
    }
  } catch {
    // localStorage can throw under strict cookie policies; fall back
    // to the default language silently.
  }
  return undefined;
}

/**
 * Returns the current preferred language and a setter that broadcasts
 * to every other instance of the hook on the page.
 *
 * @param defaultLanguage Fallback when no preference has been stored
 *   (typically the language the component would have rendered without
 *   the hook).
 */
export function usePreferredLanguage(
  defaultLanguage: LanguageId,
): readonly [LanguageId, (next: LanguageId) => void] {
  const [language, setLanguageLocal] = useState<LanguageId>(defaultLanguage);

  useEffect(() => {
    const stored = readStoredLanguage();
    if (stored !== undefined && stored !== language) {
      setLanguageLocal(stored);
    }
    // Listen for changes from other instances in this tab + other tabs.
    const onCustom = (event: Event) => {
      const detail = (event as CustomEvent<LanguageId>).detail;
      if (LANGUAGES.find((l) => l.id === detail) !== undefined) {
        setLanguageLocal(detail);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || event.newValue === null) return;
      if (LANGUAGES.find((l) => l.id === event.newValue) !== undefined) {
        setLanguageLocal(event.newValue as LanguageId);
      }
    };
    window.addEventListener(CHANGE_EVENT, onCustom);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onCustom);
      window.removeEventListener('storage', onStorage);
    };
    // Initial-mount sync only; we don't want to re-bind on every
    // local language change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLanguage = (next: LanguageId): void => {
    setLanguageLocal(next);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Best-effort persistence; the in-tab event still fires below.
    }
    window.dispatchEvent(new CustomEvent<LanguageId>(CHANGE_EVENT, { detail: next }));
  };

  return [language, setLanguage] as const;
}
