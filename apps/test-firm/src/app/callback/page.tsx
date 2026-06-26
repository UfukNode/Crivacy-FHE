/**
 * OAuth callback page — exactly the shape a real firm would write
 * when using the `crivacy.js` drop-in snippet.
 *
 * Server wrapper reads the OAuth client_id from the firm's config,
 * hands it to the client component. The client component does the
 * browser-only work:
 *
 *   1. Read `?code` + `?state` from the URL.
 *   2. Read the paired state + verifier from sessionStorage using the
 *      snippet's key convention (`crivacy.oauth.*.{clientId}`).
 *   3. Validate state (CSRF defence).
 *   4. POST { code, codeVerifier } to `/api/oauth-finish`,
 *      which runs the confidential-client token exchange with
 *      `client_secret` server-side.
 *   5. Navigate to the dashboard on success, or back to home with
 *      `?error=<code>` on failure.
 *
 * The verifier lives in sessionStorage so this step cannot be
 * server-rendered; the paired backend route is where the secret +
 * token persistence happen.
 */

import { loadTestFirmConfig } from '../config';
import { CallbackClient } from './callback-client';

export const dynamic = 'force-dynamic';

export default function TestFirmCallbackPage() {
  const cfg = loadTestFirmConfig();
  return <CallbackClient clientId={cfg.oauthClientId} />;
}
