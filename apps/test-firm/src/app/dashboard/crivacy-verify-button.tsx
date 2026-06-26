/**
 * "Verify with Crivacy" button — drop-in HTML, byte-for-byte the
 * snippet that ships in our docs (`/docs/oauth` HTML drop-in tab) and
 * in the dashboard "Integration Quick Start" drawer.
 *
 * **No React state, no React onClick, no client-side `authorize()`
 * call.** The bundled `crivacy.js` (loaded via the layout's
 * `<Script>` tag) auto-wires every element with
 * `data-crivacy-verify` on insertion (it runs a one-shot pass at
 * load and a `MutationObserver` for SPA-mounted buttons), and
 * manages busy state (`aria-busy` + `.crivacy-button__label` text
 * swap + double-click guard) on its own.
 *
 * Earlier this component had a React `onClick` that also called
 * `window.Crivacy.authorize(...)` — which fired in addition to the
 * native click listener crivacy.js installed, producing two PKCE
 * handshakes (the second one overwrote the first's verifier in
 * sessionStorage, so the token exchange landed with an orphan
 * verifier). Removing the onClick fixes the race and — more
 * importantly — makes this surface the literal copy-paste a real
 * firm would write.
 */

interface CrivacyVerifyButtonProps {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  /**
   * Issuer origin for the `/api/v1/oauth/authorize` redirect.
   * Optional — `crivacy.js` falls back to its `DEFAULT_ISSUER`
   * (`https://app.crivacy.io`). We pass it explicitly so the
   * harness routes against the dev Crivacy instance instead of
   * the prod default.
   */
  readonly issuer?: string;
  /** Visual variant — `default` (filled, dark) or `ghost` (border-only). */
  readonly variant?: 'default' | 'ghost';
  /** Idle button label. Default mirrors the docs snippet. */
  readonly label?: string;
  /** Busy label substituted by `crivacy.js` while the redirect is in flight. */
  readonly busyLabel?: string;
}

export function CrivacyVerifyButton({
  clientId,
  redirectUri,
  scope,
  issuer,
  variant = 'default',
  label = 'Verify with Crivacy',
  busyLabel,
}: CrivacyVerifyButtonProps) {
  const className =
    variant === 'ghost' ? 'crivacy-button crivacy-button--ghost' : 'crivacy-button';
  return (
    <button
      type="button"
      className={className}
      data-crivacy-verify
      data-client-id={clientId}
      data-redirect-uri={redirectUri}
      data-scope={scope}
      {...(issuer !== undefined ? { 'data-issuer': issuer } : {})}
      {...(busyLabel !== undefined ? { 'data-busy-label': busyLabel } : {})}
    >
      <svg
        className="crivacy-button__icon"
        viewBox="0 0 200 168.71"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M16.06,90.54c6.97,4.17,13.94,8.33,20.91,12.5-.73,1.32-1.64,3.18-2.39,5.53,0,0-.76,2.87-1.21,5.5-.6,3.54-.15,11.95,6.17,17.95,5.82,5.52,14.23,6.72,19.82,4.78,3.73-1.29,7.07-3.4,8-4.09,2.26-1.67,3.88-3.41,4.96-4.72,1.5,2.17,3.58,5.79,4.61,10.69.64,3.07.68,5.76.55,7.82-7.85,6.31-15.7,12.62-23.55,18.93l-46.87-30.98,9-43.92Z" />
        <path d="M182.89,90.54c-6.97,4.17-13.94,8.33-20.91,12.5.73,1.32,1.64,3.18,2.39,5.53,0,0,.76,2.87,1.21,5.5.6,3.54.15,11.95-6.17,17.95-5.82,5.52-14.23,6.72-19.82,4.78-3.73-1.29-7.07-3.4-8-4.09-2.26-1.67-3.88-3.41-4.96-4.72-1.5,2.17-3.58,5.79-4.61,10.69-.64,3.07-.68,5.76-.55,7.82,7.85,6.31,15.7,12.62,23.55,18.93l46.87-30.98-9-43.92Z" />
        <polygon points="200 28.52 195.87 69.04 118.25 120.34 100 168.71 81.75 120.34 4.13 69.04 0 28.52 42.65 60.42 87.65 49.66 100 0 112.35 49.66 157.35 60.42 200 28.52" />
      </svg>
      <span className="crivacy-button__label">{label}</span>
    </button>
  );
}
