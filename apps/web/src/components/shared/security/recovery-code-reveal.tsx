'use client';

import * as React from 'react';
import { toast } from 'sonner';

/**
 * Context threaded into the downloaded .txt file so that an IT-support
 * agent later reading a user's saved recovery codes can tell which
 * account + audience they belong to. Every field is optional, when
 * the caller has not yet resolved the session (`/me` still loading)
 * the reveal falls back to a generic "Crivacy recovery codes" header.
 *
 * Audiences pass:
 *   - customer: N/A (customer has no TOTP)
 *   - firm:    { email, firmName }
 *   - admin:   { email, audienceLabel: 'admin' }
 */
export interface RecoveryCodeDownloadContext {
  readonly email: string;
  /** Firm display name for firm users (absent on admin). */
  readonly firmName?: string;
  /** Human-readable audience label used in the filename suffix. */
  readonly audienceLabel?: 'customer' | 'firm' | 'admin';
}

export interface RecoveryCodeRevealProps {
  readonly codes: readonly string[];
  readonly context: RecoveryCodeDownloadContext | null;
  readonly onDismiss: () => void;
}

/**
 * Show a one-time recovery-code batch with Copy + Download + Dismiss
 * affordances. Shared across the firm dashboard, admin settings, and
 * the accept-invite flow so the copy + UX stay identical, every
 * surface that emits recovery codes must route through this component
 * so edits to the "saved them" affordance apply everywhere.
 *
 * Security contract:
 *   - Parent must render this ONLY AFTER the server returned the
 *     codes in a 200 response. The component does no fetching of its
 *     own, it is a pure visual reveal.
 *   - `onDismiss` is called when the user clicks "I've saved them".
 *     The parent typically flips state so the codes leave memory.
 */
export function RecoveryCodeReveal({
  codes,
  context,
  onDismiss,
}: RecoveryCodeRevealProps) {
  const handleCopy = React.useCallback(() => {
    void navigator.clipboard.writeText(codes.join('\n')).then(() => {
      toast.success('Recovery codes copied to clipboard.');
    });
  }, [codes]);

  const handleDownload = React.useCallback(() => {
    const audienceLabel = context?.audienceLabel;
    const firmName = context?.firmName;
    const email = context?.email;
    const generatedLine = `Generated: ${new Date().toISOString()}`;

    const titleLine = firmName
      ? `Crivacy recovery codes \u2014 ${firmName}`
      : audienceLabel === 'admin'
        ? 'Crivacy admin recovery codes'
        : 'Crivacy recovery codes';

    const headerLines =
      context !== null
        ? [
            titleLine,
            ...(email !== undefined ? [`Account: ${email}`] : []),
            generatedLine,
            '',
            'Each code works exactly once if you lose access to your authenticator app.',
            'Keep them somewhere safe. Regenerating in Settings voids this list.',
            '',
          ]
        : ['Crivacy recovery codes', ''];

    const body = `${headerLines.join('\n')}${codes.join('\n')}\n`;
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    // Filename convention, the most specific suffix we can produce
    // from `context`. Firms slugify their display name; admin uses a
    // dedicated label; a generic call falls back to an unsuffixed
    // filename so the user still gets a meaningful download.
    const slug = firmName
      ? `-${firmName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '')}`
      : audienceLabel === 'admin'
        ? '-admin'
        : '';
    a.download = `crivacy-recovery-codes${slug}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [codes, context]);

  return (
    <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
      <div>
        <p className="text-sm font-semibold">Save these recovery codes now.</p>
        <p className="text-sm text-[var(--color-muted)]">
          Each code can be used once to sign in if you lose your authenticator
          app. You won&rsquo;t be able to view them again.
        </p>
      </div>
      <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((code) => (
          <li
            key={code}
            className="rounded bg-black/20 px-2 py-1 text-center tracking-widest"
          >
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="rounded border border-white/20 px-3 py-1.5 text-sm hover:bg-white/5"
        >
          Copy
        </button>
        <button
          type="button"
          onClick={handleDownload}
          className="rounded border border-white/20 px-3 py-1.5 text-sm hover:bg-white/5"
        >
          Download
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-black"
        >
          I&rsquo;ve saved them
        </button>
      </div>
    </div>
  );
}
