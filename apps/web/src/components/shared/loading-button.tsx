'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface LoadingButtonProps extends ButtonProps {
  loading?: boolean;
  /** Text to show while loading (e.g. "Signing in"). If omitted, shows spinner only. */
  loadingText?: string;
  /**
   * Append three animated dots to the loading text (e.g. "Minting" →
   * "Minting•••" with each dot bouncing in sequence). Off by default
   * because most short ops (login, save) are fine with the spinner +
   * static text. Long-running on-chain ops (NFT mint, credential
   * issue) feel less stuck with motion on the dots.
   */
  animatedDots?: boolean;
}

/**
 * Button that shows a spinner and disables itself during async operations.
 * Prevents double-click by disabling on loading state.
 */
const LoadingButton = React.forwardRef<HTMLButtonElement, LoadingButtonProps>(
  (
    { loading = false, loadingText, animatedDots = false, disabled, children, className, ...props },
    ref,
  ) => {
    return (
      <Button
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn('relative', className)}
        {...props}
      >
        {loading && (
          <Loader2
            className={cn(
              'h-4 w-4 animate-spin text-current',
              loadingText
                ? 'mr-2'
                : 'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
            )}
            aria-hidden="true"
          />
        )}
        {loading && loadingText ? (
          <span className="inline-flex items-baseline">
            <span>{loadingText}</span>
            {animatedDots && (
              <span aria-hidden="true" className="inline-flex">
                <span className="animate-bounce [animation-delay:-0.3s]">.</span>
                <span className="animate-bounce [animation-delay:-0.15s]">.</span>
                <span className="animate-bounce">.</span>
              </span>
            )}
          </span>
        ) : (
          <span className={cn('inline-flex items-center gap-2', loading && !loadingText && 'invisible')}>{children}</span>
        )}
      </Button>
    );
  },
);
LoadingButton.displayName = 'LoadingButton';

export { LoadingButton };
