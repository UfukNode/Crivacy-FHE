'use client';

/**
 * Copy-to-clipboard button rendered inside every MDX `<pre>` block.
 *
 * The button walks up the DOM to its parent wrapper and pulls the
 * text content of the sibling `<pre>`, so MDX authors don't need to
 * pass the source string through a prop, this works even when
 * Shiki has already rewritten the `<code>` children into a forest
 * of spans with syntax highlighting.
 *
 * Rendered with `absolute` positioning; the parent `<Pre>` wrapper
 * is `relative`. Visibility is driven by the `group-hover` class so
 * the button stays out of the way while the reader is scanning and
 * appears on hover / focus for copy.
 */

import { useRef, useState } from 'react';

import { Check, Copy, X } from 'lucide-react';

type CopyState = 'idle' | 'copied' | 'failed';

export function CodeCopyButton() {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [state, setState] = useState<CopyState>('idle');

  async function handleCopy() {
    const wrapper = btnRef.current?.closest('[data-code-wrapper]');
    const pre = wrapper?.querySelector('pre');
    const text = pre?.textContent ?? '';
    if (text.length === 0) {
      setState('failed');
      setTimeout(() => setState('idle'), 1500);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      // Older browsers / insecure contexts fall through to a
      // textarea-based copy so the button still works on localhost
      // over HTTP.
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        setState('copied');
      } catch {
        setState('failed');
      }
    }
    setTimeout(() => setState('idle'), 1500);
  }

  const icon =
    state === 'copied' ? (
      <Check className="h-3.5 w-3.5 text-[var(--color-success)]" aria-hidden="true" />
    ) : state === 'failed' ? (
      <X className="h-3.5 w-3.5 text-[var(--color-danger)]" aria-hidden="true" />
    ) : (
      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
    );
  const label =
    state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed to copy' : 'Copy code';

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={() => void handleCopy()}
      aria-label={label}
      title={label}
      className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] opacity-0 transition-all duration-[var(--duration-fast)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] focus-visible:opacity-100 group-hover:opacity-100"
    >
      {icon}
    </button>
  );
}
