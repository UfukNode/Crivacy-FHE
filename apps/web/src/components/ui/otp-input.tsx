'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/* ---------- Types ---------- */

interface OtpInputProps {
  /** Number of digits (default: 6). */
  readonly length?: number;
  /** Called with the full code when all digits are filled. */
  readonly onComplete?: (code: string) => void;
  /** Called on every change with partial/full code. */
  readonly onChange?: (code: string) => void;
  /** Disable all inputs. */
  readonly disabled?: boolean;
  /** Show error styling. */
  readonly error?: boolean;
  /** Auto-focus the first input on mount. */
  readonly autoFocus?: boolean;
}

/* ---------- Component ---------- */

/**
 * 6-digit (configurable) OTP input with individual boxes.
 *
 * Features:
 *   - Auto-advance on digit entry
 *   - Backspace goes to previous box
 *   - Full paste support (paste 6 digits → fill all boxes)
 *   - Keyboard-navigable (arrow keys)
 *   - Screen-reader accessible (aria-label per digit)
 */
export function OtpInput({
  length = 6,
  onComplete,
  onChange,
  disabled = false,
  error = false,
  autoFocus = false,
}: OtpInputProps) {
  const [values, setValues] = React.useState<string[]>(() => Array.from<string>({ length }).fill(''));
  const inputRefs = React.useRef<(HTMLInputElement | null)[]>([]);

  // Expose reset via imperative handle? Not needed, parent can key-swap.

  const focusInput = React.useCallback((index: number) => {
    const input = inputRefs.current[index];
    if (input) {
      input.focus();
      input.select();
    }
  }, []);

  const updateValues = React.useCallback(
    (newValues: string[]) => {
      setValues(newValues);
      const code = newValues.join('');
      onChange?.(code);
      if (code.length === length && /^\d+$/.test(code)) {
        onComplete?.(code);
      }
    },
    [length, onChange, onComplete],
  );

  const handleChange = React.useCallback(
    (index: number, value: string) => {
      // Only accept digits
      const digit = value.replace(/\D/g, '').slice(-1);
      const newValues = [...values];
      newValues[index] = digit;
      updateValues(newValues);

      // Auto-advance to next input
      if (digit.length === 1 && index < length - 1) {
        focusInput(index + 1);
      }
    },
    [values, length, focusInput, updateValues],
  );

  const handleKeyDown = React.useCallback(
    (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Backspace') {
        if (values[index] === '' && index > 0) {
          // Move to previous and clear it
          const newValues = [...values];
          newValues[index - 1] = '';
          updateValues(newValues);
          focusInput(index - 1);
          e.preventDefault();
        } else {
          // Clear current
          const newValues = [...values];
          newValues[index] = '';
          updateValues(newValues);
        }
      } else if (e.key === 'ArrowLeft' && index > 0) {
        focusInput(index - 1);
        e.preventDefault();
      } else if (e.key === 'ArrowRight' && index < length - 1) {
        focusInput(index + 1);
        e.preventDefault();
      }
    },
    [values, length, focusInput, updateValues],
  );

  const handlePaste = React.useCallback(
    (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const pasted = e.clipboardData.getData('text/plain').replace(/\D/g, '').slice(0, length);
      if (pasted.length === 0) return;

      const newValues = [...values];
      for (let i = 0; i < pasted.length; i++) {
        newValues[i] = pasted[i] ?? '';
      }
      updateValues(newValues);

      // Focus the next empty input, or the last one
      const nextEmpty = newValues.findIndex((v) => v === '');
      focusInput(nextEmpty >= 0 ? nextEmpty : length - 1);
    },
    [values, length, focusInput, updateValues],
  );

  // Auto-focus first input on mount
  React.useEffect(() => {
    if (autoFocus) {
      focusInput(0);
    }
  }, [autoFocus, focusInput]);

  return (
    <div className="flex items-center justify-center gap-2" role="group" aria-label="One-time password input">
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          ref={(el) => {
            inputRefs.current[index] = el;
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          value={values[index] ?? ''}
          onChange={(e) => handleChange(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onPaste={handlePaste}
          onFocus={(e) => e.target.select()}
          disabled={disabled}
          aria-label={`Digit ${index + 1} of ${length}`}
          autoComplete="one-time-code"
          className={cn(
            'h-12 w-10 rounded-[var(--radius-sm)] border bg-[var(--color-surface)] text-center text-lg font-semibold text-[var(--color-fg)] transition-colors',
            'focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/30',
            'disabled:cursor-not-allowed disabled:opacity-50',
            error
              ? 'border-[var(--color-danger)] focus:border-[var(--color-danger)] focus:ring-[var(--color-danger)]/30'
              : 'border-[var(--color-border)]',
          )}
        />
      ))}
    </div>
  );
}
