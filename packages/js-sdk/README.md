# @crivacy/js-sdk

OAuth 2.0 + OpenID Connect client SDK for the [Crivacy](https://app.crivacy.io) KYC platform.

Works in modern browsers, Node.js 18+, Bun and Deno. Zero runtime dependencies — backed by the Web Crypto API and the platform `fetch`.

## Install

```bash
npm install @crivacy/js-sdk
# or
pnpm add @crivacy/js-sdk
```

## Browser usage — redirect flow

```ts
import { CrivacyClient, CrivacyOauthError, isCrivacyOauthError } from '@crivacy/js-sdk';

const client = new CrivacyClient({
  clientId: 'crv_oauth_live_xxxxxxxxxxxxx',
  redirectUri: 'https://your.app/oauth/callback',
});

// On your "Verify with Crivacy" button click:
document.querySelector('#verify')?.addEventListener('click', () => {
  client.authorize({ scope: ['openid', 'kyc'] });
});
```

On your `/oauth/callback` page:

```ts
import { CrivacyClient, isCrivacyOauthError } from '@crivacy/js-sdk';

const client = new CrivacyClient({
  clientId: 'crv_oauth_live_xxxxxxxxxxxxx',
  redirectUri: 'https://your.app/oauth/callback',
});

try {
  const { code, codeVerifier } = await client.handleCallback();
  // Forward { code, codeVerifier } to your backend — never exchange
  // a code from the browser unless this is a public (PKCE-only) client.
  await fetch('/api/finish-signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier }),
  });
} catch (err) {
  if (isCrivacyOauthError(err)) {
    console.error(err.code, err.description);
  }
}
```

## Server-side — code exchange

```ts
import { CrivacyClient } from '@crivacy/js-sdk';

const client = new CrivacyClient({
  clientId: process.env.CRIVACY_CLIENT_ID!,
  clientSecret: process.env.CRIVACY_CLIENT_SECRET!,
  redirectUri: 'https://your.app/oauth/callback',
});

// inside your /api/finish-signup handler:
const tokens = await client.exchangeCode({ code, codeVerifier });
const claims = await client.getUserinfo(tokens.access_token);

if (claims.identity_verified !== true) throw new Error('KYC required');
return { userId: claims.sub };
```

## Public clients (SPAs / native)

Public clients authenticate with PKCE alone — no `client_secret`. The SDK handles this automatically when `clientSecret` is omitted:

```ts
const client = new CrivacyClient({
  clientId: 'crv_oauth_live_public_spa_xxxx',
  redirectUri: 'https://your.app/oauth/callback',
});

await client.authorize({ scope: ['openid', 'kyc'] });
// …later…
const { code, codeVerifier } = await client.handleCallback();
const tokens = await client.exchangeCode({ code, codeVerifier });
```

## Custom storage

The SDK needs to persist the PKCE verifier + state between the authorize redirect and the callback. The default storage is `sessionStorage` with an in-memory fallback. Override with your own implementation when `sessionStorage` isn't available (React Native, extensions, encrypted stores):

```ts
import { CrivacyClient, type SdkStorage } from '@crivacy/js-sdk';

const storage: SdkStorage = {
  getItem: async (k) => mySecureStore.read(k),
  setItem: async (k, v) => mySecureStore.write(k, v),
  removeItem: async (k) => mySecureStore.delete(k),
};

const client = new CrivacyClient({ clientId, redirectUri }, storage);
```

## Error handling

Every failure throws a `CrivacyOauthError` with a `.code` matching the OAuth 2.0 / RFC 9700 vocabulary:

| code | meaning |
|---|---|
| `access_denied` | User rejected the consent screen |
| `state_mismatch` | CSRF token from storage did not match the callback query |
| `missing_verifier` | Storage was cleared before the callback (user came back on a new tab?) |
| `invalid_grant` | Server refused the code — expired, reused, or wrong client |
| `invalid_client` | Wrong `client_secret` or unknown `client_id` |
| `pkce_invalid` | The verifier doesn't match the original challenge |
| `network_error` | Underlying `fetch` rejected |

Use `isCrivacyOauthError(err)` to type-narrow.

## API reference

### `new CrivacyClient(options, storage?)`

- `options.clientId` — required.
- `options.redirectUri` — required, exact match against the value registered in the Crivacy dashboard.
- `options.clientSecret` — required for confidential clients, must NOT be set in the browser.
- `options.issuer` — default `https://app.crivacy.io`.
- `options.fetch` — override the global `fetch`.

### `client.buildAuthorizeUrl({ scope, nonce?, redirectUri?, uiLocales? })`

Returns `{ url, state, codeVerifier, nonce? }` without navigating. Useful for SSR and testing.

### `client.authorize({ scope, ... })`

Browser convenience — builds the URL and navigates the current tab. Returns a `Promise<never>`.

### `client.handleCallback(input?)`

Parses the callback URL (default: `window.location`), validates state, returns `{ code, codeVerifier, redirectUri, state }`.

### `client.exchangeCode({ code, codeVerifier, redirectUri? })`

Exchanges the code for a token response `{ access_token, token_type, expires_in, scope, id_token? }`.

### `client.getUserinfo(accessToken)`

Fetches the userinfo claim set.

## License

MIT — see [LICENSE](./LICENSE).
