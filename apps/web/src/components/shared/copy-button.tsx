'use client';

import * as React from 'react';
import { Check, Copy, X } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick'> {
  value: string;
  /** Label shown (defaults to "Copy") */
  label?: string;
  /** Icon-only mode (no label text) */
  iconOnly?: boolean;
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Copy to clipboard with visual feedback.
 * Idle: clipboard icon. Copied: green check (1.5s). Failed: red X (1.5s).
 */
export function CopyButton({
  value,
  label = 'Copy',
  iconOnly = false,
  className,
  variant = 'ghost',
  size = iconOnly ? 'icon' : 'sm',
  ...props
}: CopyButtonProps) {
  const [state, setState] = React.useState<CopyState>('idle');
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      // Fallback for older browsers
      try {
        const textarea = document.createElement('textarea');
        textarea.value = value;
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

    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setState('idle'), 1500);
  }, [value]);

  React.useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  const Icon = state === 'copied' ? Check : state === 'failed' ? X : Copy;
  const ariaLabel = state === 'copied' ? 'Copied!' : state === 'failed' ? 'Copy failed' : label;

  return (
    <Button
      // HTML default for `<button>` inside a `<form>` is `submit`.
      // Copy buttons are never submit actions, so force `type="button"`
      // here to prevent an accidental form submit when this component
      // is dropped into an onboarding/settings form. Callers can still
      // override via props if they really need a submit-style copy.
      type="button"
      variant={variant}
      size={size}
      className={cn(
        state === 'copied' && 'text-[var(--color-success)]',
        state === 'failed' && 'text-[var(--color-danger)]',
        className,
      )}
      onClick={handleCopy}
      aria-label={ariaLabel}
      {...props}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {!iconOnly && (
        <span>{state === 'copied' ? 'Copied!' : state === 'failed' ? 'Failed' : label}</span>
      )}
    </Button>
  );
}
