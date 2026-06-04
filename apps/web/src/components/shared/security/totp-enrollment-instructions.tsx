/**
 * TOTP enrollment copy shared by every authenticator-setup surface,
 * firm settings, admin settings, accept-invite. Kept as a standalone
 * component so edits to the numbered steps or the app-link list land
 * in every flow at once.
 *
 * Links open in a new tab with `rel="noopener noreferrer"` so the
 * target page cannot reach back into this window via `window.opener`.
 */

export function TotpEnrollmentInstructions() {
  return (
    <div className="space-y-2">
      <ol className="list-decimal space-y-1 pl-5 text-xs text-[var(--color-muted)]">
        <li>Install an authenticator app on your phone.</li>
        <li>Scan the QR below (or enter the secret manually).</li>
        <li>Enter the 6-digit code your app displays.</li>
      </ol>
      <p className="text-xs text-[var(--color-muted)]">
        Don&apos;t have one?{' '}
        <a
          href="https://apps.apple.com/app/google-authenticator/id388497605"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--color-accent)] underline-offset-2 hover:underline"
        >
          Google Authenticator (iOS)
        </a>
        {' · '}
        <a
          href="https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--color-accent)] underline-offset-2 hover:underline"
        >
          Android
        </a>
        {' · '}
        <a
          href="https://1password.com/downloads/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--color-accent)] underline-offset-2 hover:underline"
        >
          1Password
        </a>
      </p>
    </div>
  );
}
