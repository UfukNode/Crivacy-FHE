/**
 * Test-firm harness configuration.
 *
 * This file is the single source of truth for the test-firm consumer's
 * credentials, its OWN origin, and the Crivacy gateway base URL. Every
 * route in this app imports from here — nothing pulls
 * `process.env.TEST_FIRM_*` directly.
 *
 * This app runs as a SEPARATE process on its own origin (dev:
 * localhost:3002) and talks to Crivacy over the network exactly like a
 * real third-party firm would. That means two distinct base URLs:
 *
 *  - `apiBaseUrl` = the Crivacy gateway (`CRIVACY_API_BASE_URL`,
 *    dev: http://localhost:3001). All OAuth (authorize/token/userinfo)
 *    and REST API calls target this.
 *  - `ownOrigin` = this firm's own public origin (`NEXT_PUBLIC_APP_URL`,
 *    dev: http://localhost:3002). The OAuth redirect_uri and the webhook
 *    receiver URL are built from it.
 *
 * Why centralized:
 *  - Missing env must fail LOUDLY (CLAUDE.md "No Hardcoded Fallbacks").
 *    `loadTestFirmConfig` throws on first call if anything is absent.
 *  - The OAuth redirect_uri must EXACTLY match what was registered in
 *    the oauth_clients row. Deriving it from `ownOrigin` keeps the two
 *    in lockstep — change the port in one place, both follow.
 *
 * These credentials belong to a real firm in the Crivacy dev database.
 * This harness is a dev/demo artifact; it is NOT meant to ship to
 * production.
 */

import { z } from 'zod';

export interface TestFirmConfig {
  readonly oauthClientId: string;
  readonly oauthClientSecret: string;
  readonly apiKey: string;
  /** Crivacy gateway base URL (OAuth + REST API target). Dev: :3001. */
  readonly apiBaseUrl: string;
  /** This firm's own public origin (redirect_uri + webhook base). Dev: :3002. */
  readonly ownOrigin: string;
  readonly redirectUri: string;
  /**
   * Secret that Crivacy prints once when a webhook endpoint is
   * registered. Optional in config — the receiver surfaces a clear
   * "not configured" error if an event arrives without the secret
   * being present in env.
   */
  readonly webhookSecret: string | null;
}

const EnvSchema = z.object({
  TEST_FIRM_OAUTH_CLIENT_ID: z.string().min(1, 'TEST_FIRM_OAUTH_CLIENT_ID is required'),
  TEST_FIRM_OAUTH_CLIENT_SECRET: z
    .string()
    .min(1, 'TEST_FIRM_OAUTH_CLIENT_SECRET is required'),
  TEST_FIRM_API_KEY: z.string().min(1, 'TEST_FIRM_API_KEY is required'),
  // Webhook secret is optional to allow standing up the harness
  // BEFORE a webhook endpoint has been registered in Crivacy. Once
  // webhooks are needed, set it in .env and restart.
  TEST_FIRM_WEBHOOK_SECRET: z.string().min(1).optional(),
  // This firm's own public origin — redirect_uri + webhook URL derive from it.
  NEXT_PUBLIC_APP_URL: z.string().url('NEXT_PUBLIC_APP_URL must be an absolute URL'),
  // The Crivacy gateway this firm calls (OAuth + REST). Separate origin.
  CRIVACY_API_BASE_URL: z.string().url('CRIVACY_API_BASE_URL must be an absolute URL'),
});

let cached: TestFirmConfig | null = null;

/**
 * Resolve the test-firm config once per process. Throws on missing env
 * vars so a broken setup is visible at first use rather than producing
 * silent 500s deep inside the OAuth flow.
 */
export function loadTestFirmConfig(): TestFirmConfig {
  if (cached !== null) return cached;

  const parsed = EnvSchema.safeParse({
    TEST_FIRM_OAUTH_CLIENT_ID: process.env['TEST_FIRM_OAUTH_CLIENT_ID'],
    TEST_FIRM_OAUTH_CLIENT_SECRET: process.env['TEST_FIRM_OAUTH_CLIENT_SECRET'],
    TEST_FIRM_API_KEY: process.env['TEST_FIRM_API_KEY'],
    TEST_FIRM_WEBHOOK_SECRET: process.env['TEST_FIRM_WEBHOOK_SECRET'],
    NEXT_PUBLIC_APP_URL: process.env['NEXT_PUBLIC_APP_URL'],
    CRIVACY_API_BASE_URL: process.env['CRIVACY_API_BASE_URL'],
  });

  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(`[test-firm] configuration invalid: ${missing}`);
  }

  const ownOrigin = parsed.data.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  const apiBaseUrl = parsed.data.CRIVACY_API_BASE_URL.replace(/\/$/, '');

  cached = {
    oauthClientId: parsed.data.TEST_FIRM_OAUTH_CLIENT_ID,
    oauthClientSecret: parsed.data.TEST_FIRM_OAUTH_CLIENT_SECRET,
    apiKey: parsed.data.TEST_FIRM_API_KEY,
    apiBaseUrl,
    ownOrigin,
    redirectUri: `${ownOrigin}/callback`,
    webhookSecret: parsed.data.TEST_FIRM_WEBHOOK_SECRET ?? null,
  };

  return cached;
}

/**
 * Cookie names used by the test-firm harness. Namespaced with
 * `tf_` so they don't collide with Crivacy's own session cookies.
 */
export const TEST_FIRM_COOKIES = {
  /** Stores the OAuth `state` param between /signin and /callback. */
  state: 'tf_oauth_state',
  /** Stores the access_token returned from /token, used by the
   *  userinfo proxy and the dashboard page. httpOnly. */
  accessToken: 'tf_access_token',
  /** Stores the scope granted by the user at consent — kept so the
   *  dashboard can hide claim rows the user did not authorise. */
  scope: 'tf_scope',
} as const;

/** Scopes the harness requests at /authorize. Subset of what the
 *  OAuth client has `allowed_scopes` for. */
export const TEST_FIRM_SCOPES = [
  'openid',
  'kyc',
  'credential',
  'kyc:scores',
] as const;
