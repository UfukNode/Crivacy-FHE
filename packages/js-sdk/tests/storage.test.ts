// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  clearAuthorizationRequest,
  persistAuthorizationRequest,
  readAuthorizationRequest,
  type SdkStorage,
} from '../src/storage';

function buildMemoryStorage(): SdkStorage {
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

describe('storage — persist/read round-trip', () => {
  it('stores and reads back state + verifier + redirect', async () => {
    const storage = buildMemoryStorage();
    await persistAuthorizationRequest(storage, 'client-1', {
      state: 'abc',
      codeVerifier: 'v'.repeat(64),
      redirectUri: 'https://app/cb',
    });
    const loaded = await readAuthorizationRequest(storage, 'client-1');
    expect(loaded).toEqual({
      state: 'abc',
      codeVerifier: 'v'.repeat(64),
      redirectUri: 'https://app/cb',
    });
  });

  it('carries the nonce through when supplied', async () => {
    const storage = buildMemoryStorage();
    await persistAuthorizationRequest(storage, 'client-1', {
      state: 'abc',
      codeVerifier: 'v'.repeat(64),
      redirectUri: 'https://app/cb',
      nonce: 'n-42',
    });
    const loaded = await readAuthorizationRequest(storage, 'client-1');
    expect(loaded?.nonce).toBe('n-42');
  });

  it('returns null when the request has not been persisted', async () => {
    const storage = buildMemoryStorage();
    expect(await readAuthorizationRequest(storage, 'client-1')).toBeNull();
  });

  it('scopes by clientId so two clients in the same tab do not collide', async () => {
    const storage = buildMemoryStorage();
    await persistAuthorizationRequest(storage, 'a', {
      state: 'sa',
      codeVerifier: 'v'.repeat(64),
      redirectUri: 'https://a/cb',
    });
    await persistAuthorizationRequest(storage, 'b', {
      state: 'sb',
      codeVerifier: 'w'.repeat(64),
      redirectUri: 'https://b/cb',
    });
    const a = await readAuthorizationRequest(storage, 'a');
    const b = await readAuthorizationRequest(storage, 'b');
    expect(a?.state).toBe('sa');
    expect(b?.state).toBe('sb');
  });

  it('clear removes all four keys for a given clientId', async () => {
    const storage = buildMemoryStorage();
    await persistAuthorizationRequest(storage, 'c', {
      state: 's',
      codeVerifier: 'v'.repeat(64),
      redirectUri: 'https://a/cb',
      nonce: 'n',
    });
    await clearAuthorizationRequest(storage, 'c');
    expect(await readAuthorizationRequest(storage, 'c')).toBeNull();
  });
});
