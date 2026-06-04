'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { PASSWORD_MAX_LENGTH } from '@/lib/validation/auth';
import { cn } from '@/lib/utils';

export interface PasswordInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {}

/**
 * Input with show/hide password toggle.
 * Accessible: toggle button has aria-label, input type switches.
 */
const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, ...props }, ref) => {
    const [showPassword, setShowPassword] = React.useState(false);
    const tooltipLabel = showPassword ? 'Hide password' : 'Show password';

    return (
      <div className="relative">
        {/*
          Suppress Edge / Chromium's built-in password reveal icon
          (`::-ms-reveal`) + Safari's auto-fill button so they don't
          stack on top of our own eye toggle. Scoped to this
          component via a generated class; inline <style jsx> would
          need the pragma but this is cleaner.
        */}
        <style>{`
          .crivacy-password-input::-ms-reveal,
          .crivacy-password-input::-ms-clear {
            display: none;
          }
          .crivacy-password-input::-webkit-credentials-auto-fill-button,
          .crivacy-password-input::-webkit-caps-lock-indicator {
            display: none !important;
            visibility: hidden;
            pointer-events: none;
            -webkit-appearance: none;
          }
        `}</style>
        <Input
          ref={ref}
          // Defensive defaults applied BEFORE the prop spread so a
          // caller can still override them (e.g. a flow that needs a
          // tighter `maxLength`). The backend enforces
          // `PASSWORD_MAX_LENGTH` in `lib/validation/auth.ts`; mirroring
          // the cap on the client stops the user from typing past
          // backend validation. `spellCheck={false}` is browser-default
          // for `type="password"` but explicit here so the same prop
          // applies even when the user toggles the field to plain text
          // via the eye button (some Chromium variants re-enable
          // spellcheck on `type="text"` mid-life).
          maxLength={PASSWORD_MAX_LENGTH}
          spellCheck={false}
          type={showPassword ? 'text' : 'password'}
          className={cn('crivacy-password-input pr-10', className)}
          {...props}
        />
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-r-[var(--radius-md)] text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] focus-visible:text-[var(--color-fg)]"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={tooltipLabel}
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>{tooltipLabel}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  },
);
PasswordInput.displayName = 'PasswordInput';

export { PasswordInput };
