/**
 * PKCE verifier + state persistence between the authorize redirect
 * and the callback.
 *
 * Browsers need to remember `code_verifier` and `state` across a
 * full navigation to Crivacy and back. `sessionStorage` is the
 * default — scoped to the tab, cleared when it closes, survives a
 * full page reload. Firms with a custom storage model (React Native,
 * Ionic, their own encrypted store) may pass a custom
 * `SdkStorage` implementation.
 *
 * @module
 */

import { CrivacyOauthError } from './errors';

export interface SdkStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/**
 * Wraps the browser `sessionStorage` in the SdkStorage shape. Falls
 * back to an in-memory map when `sessionStorage` isn't available —
 * e.g. private browsing modes that throw on writes. The in-memory
 * fallback is lost on reload; callers should treat that as "the
 * user aborted" and restart the flow.
 */
export function createDefaultStorage(): SdkStorage {
  if (typeof globalThis.sessionStorage !== 'undefined') {
    try {
      const probe = '__crivacy_probe__';
      globalThis.sessionStorage.setItem(probe, probe);
      globalThis.sessionStorage.removeItem(probe);
      return {
        getItem: (k) => globalThis.sessionStorage.getItem(k),
        setItem: (k, v) => {
          globalThis.sessionStorage.setItem(k, v);
        },
        removeItem: (k) => {
          globalThis.sessionStorage.removeItem(k);
        },
      };
    } catch {
      // fall through to the in-memory store
    }
  }
  const memory = new Map<string, string>();
  return {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => {
      memory.set(k, v);
    },
    removeItem: (k) => {
      memory.delete(k);
    },
  };
}

// ---------------------------------------------------------------------------
// Typed read/write helpers around a single authorize request
// ---------------------------------------------------------------------------

const STATE_KEY_PREFIX = 'crivacy.oauth.state.';
const VERIFIER_KEY_PREFIX = 'crivacy.oauth.verifier.';
const NONCE_KEY_PREFIX = 'crivacy.oauth.nonce.';
const REDIRECT_KEY_PREFIX = 'crivacy.oauth.redirect.';

export interface StoredAuthorizationRequest {
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce?: string;
  readonly redirectUri: string;
}

export async function persistAuthorizationRequest(
  storage: SdkStorage,
  clientId: string,
  req: StoredAuthorizationRequest,
): Promise<void> {
  try {
    await storage.setItem(STATE_KEY_PREFIX + clientId, req.state);
    await storage.setItem(VERIFIER_KEY_PREFIX + clientId, req.codeVerifier);
    if (req.nonce !== undefined) {
      await storage.setItem(NONCE_KEY_PREFIX + clientId, req.nonce);
    }
    await storage.setItem(REDIRECT_KEY_PREFIX + clientId, req.redirectUri);
  } catch (err) {
    throw new CrivacyOauthError(
      'storage_unavailable',
      'Could not write OAuth state to storage.',
      { cause: err },
    );
  }
}

export async function readAuthorizationRequest(
  storage: SdkStorage,
  clientId: string,
): Promise<StoredAuthorizationRequest | null> {
  try {
    const state = await storage.getItem(STATE_KEY_PREFIX + clientId);
    const codeVerifier = await storage.getItem(VERIFIER_KEY_PREFIX + clientId);
    const redirectUri = await storage.getItem(REDIRECT_KEY_PREFIX + clientId);
    if (state === null || codeVerifier === null || redirectUri === null) {
      return null;
    }
    const nonce = await storage.getItem(NONCE_KEY_PREFIX + clientId);
    return nonce === null
      ? { state, codeVerifier, redirectUri }
      : { state, codeVerifier, nonce, redirectUri };
  } catch (err) {
    throw new CrivacyOauthError(
      'storage_unavailable',
      'Could not read OAuth state from storage.',
      { cause: err },
    );
  }
}

export async function clearAuthorizationRequest(
  storage: SdkStorage,
  clientId: string,
): Promise<void> {
  await storage.removeItem(STATE_KEY_PREFIX + clientId);
  await storage.removeItem(VERIFIER_KEY_PREFIX + clientId);
  await storage.removeItem(NONCE_KEY_PREFIX + clientId);
  await storage.removeItem(REDIRECT_KEY_PREFIX + clientId);
}
