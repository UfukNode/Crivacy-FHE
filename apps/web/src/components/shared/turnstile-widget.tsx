'use client';

import { Turnstile } from '@marsidev/react-turnstile';

interface TurnstileWidgetProps {
  readonly onSuccess: (token: string) => void;
  readonly onError?: () => void;
  readonly onExpire?: () => void;
}

/**
 * Read `NEXT_PUBLIC_TURNSTILE_SITE_KEY` from the build-time env. Throws
 * if missing, fail-loud matches the server-side config rule
 * (`getCustomerAuthConfig().turnstileSiteKey` also rejects empty). No
 * silent test-key fallback, CLAUDE.md "No Hardcoded Fallbacks":
 * prod deploy that forgets the env must crash, not bypass captcha.
 * Local dev has `1x00000000000000000000AA` in `.env` so this never
 * throws in a properly-configured repo.
 */
function requireSiteKey(): string {
  const key = process.env['NEXT_PUBLIC_TURNSTILE_SITE_KEY'];
  if (key === undefined || key.length === 0) {
    throw new Error(
      'NEXT_PUBLIC_TURNSTILE_SITE_KEY is required, set it in .env ' +
        '(use Cloudflare test key `1x00000000000000000000AA` locally).',
    );
  }
  return key;
}

/**
 * Cloudflare Turnstile invisible widget.
 *
 * Site key is required at build time; missing env = hard crash on the
 * first render so an operator sees the misconfiguration before any
 * real user hits the form.
 */
export function TurnstileWidget({ onSuccess, onError, onExpire }: TurnstileWidgetProps) {
  return (
    <Turnstile
      siteKey={requireSiteKey()}
      onSuccess={onSuccess}
      onError={onError}
      onExpire={onExpire}
      options={{
        size: 'invisible',
        theme: 'auto',
      }}
    />
  );
}
