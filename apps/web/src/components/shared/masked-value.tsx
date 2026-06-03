'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/shared/copy-button';
import { cn } from '@/lib/utils';

export interface MaskedValueProps {
  value: string;
  /** Number of visible characters at start (default 8) */
  visiblePrefix?: number;
  /** Auto-hide after reveal (milliseconds, default 5000) */
  autoHideMs?: number;
  /** Show copy button */
  copyable?: boolean;
  className?: string;
}

/**
 * Masked secret display with reveal toggle.
 * API Key: crv_live_●●●●●●●●  [Reveal] [Copy]
 * Reveal auto-hides after 5s.
 */
export function MaskedValue({
  value,
  visiblePrefix = 8,
  autoHideMs = 5000,
  copyable = true,
  className,
}: MaskedValueProps) {
  const [revealed, setRevealed] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  const masked = React.useMemo(() => {
    const prefix = value.slice(0, visiblePrefix);
    const remaining = value.length - visiblePrefix;
    return `${prefix}${'●'.repeat(Math.min(remaining, 16))}`;
  }, [value, visiblePrefix]);

  const handleToggle = React.useCallback(() => {
    if (!revealed) {
      setRevealed(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setRevealed(false), autoHideMs);
    } else {
      setRevealed(false);
      clearTimeout(timeoutRef.current);
    }
  }, [revealed, autoHideMs]);

  React.useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <code className="rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-2 py-1 font-mono text-sm text-[var(--color-fg)]">
        {revealed ? value : masked}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={handleToggle}
        aria-label={revealed ? 'Hide value' : 'Reveal value'}
      >
        {revealed ? (
          <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </Button>
      {copyable && <CopyButton value={value} iconOnly />}
    </div>
  );
}
