'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface VerificationCodeInputProps {
  /** Number of digits (default 6). */
  length?: number;
  /** Called when all digits are entered. */
  onComplete: (code: string) => void;
  /** External error message (e.g. "Invalid code"). */
  error?: string | undefined;
  /** Disable the input (e.g. during submission). */
  disabled?: boolean;
  /** Auto-focus the first input on mount. */
  autoFocus?: boolean;
}

/**
 * 6-digit verification code input.
 *
 * Features:
 * - Auto-advance on digit entry
 * - Backspace returns to previous box
 * - Paste handling: distributes digits across all boxes, auto-submits
 * - Auto-submit when all 6 digits are entered
 * - Shake animation on error
 * - Accessible with aria-label per box
 */
export function VerificationCodeInput({
  length = 6,
  onComplete,
  error,
  disabled = false,
  autoFocus = true,
}: VerificationCodeInputProps) {
  const [values, setValues] = React.useState<string[]>(Array(length).fill(''));
  const inputRefs = React.useRef<(HTMLInputElement | null)[]>([]);
  const [shake, setShake] = React.useState(false);

  // Trigger shake animation on error change
  React.useEffect(() => {
    if (error) {
      setShake(true);
      const timer = setTimeout(() => setShake(false), 500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [error]);

  // Auto-focus first input on mount
  React.useEffect(() => {
    if (autoFocus && inputRefs.current[0]) {
      inputRefs.current[0].focus();
    }
  }, [autoFocus]);

  function handleChange(index: number, value: string) {
    // Only allow single digit
    const digit = value.replace(/\D/g, '').slice(-1);
    const newValues = [...values];
    newValues[index] = digit;
    setValues(newValues);

    // Auto-advance to next box
    if (digit !== '' && index < length - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all boxes filled
    if (digit !== '' && newValues.every((v) => v !== '')) {
      onComplete(newValues.join(''));
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      if (values[index] === '' && index > 0) {
        // Move to previous box
        const newValues = [...values];
        newValues[index - 1] = '';
        setValues(newValues);
        inputRefs.current[index - 1]?.focus();
        e.preventDefault();
      } else {
        // Clear current box
        const newValues = [...values];
        newValues[index] = '';
        setValues(newValues);
      }
    }
    if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus();
      e.preventDefault();
    }
    if (e.key === 'ArrowRight' && index < length - 1) {
      inputRefs.current[index + 1]?.focus();
      e.preventDefault();
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/[\s\-]/g, '').replace(/\D/g, '');
    if (pasted.length === 0) return;

    const digits = pasted.slice(0, length).split('');
    const newValues = [...values];
    for (let i = 0; i < digits.length; i++) {
      newValues[i] = digits[i]!;
    }
    setValues(newValues);

    // Focus the next empty box, or the last filled box
    const nextEmpty = newValues.findIndex((v) => v === '');
    if (nextEmpty !== -1) {
      inputRefs.current[nextEmpty]?.focus();
    } else {
      inputRefs.current[length - 1]?.focus();
      // All filled, auto-submit
      onComplete(newValues.join(''));
    }
  }

  /**
   * Reset all values (called externally when error occurs and user needs to retry).
   */
  React.useImperativeHandle(
    // Allow parent to call ref.current?.reset() if needed
    // But since this is a function component, we expose reset via effect
    undefined,
    () => {},
  );

  return (
    <div className="space-y-2">
      <div
        className={cn(
          'flex items-center justify-center gap-2',
          shake && 'animate-shake',
        )}
        role="group"
        aria-label="Verification code"
      >
        {values.map((value, index) => (
          <input
            key={index}
            ref={(el) => { inputRefs.current[index] = el; }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            value={value}
            disabled={disabled}
            onChange={(e) => handleChange(index, e.target.value)}
            onKeyDown={(e) => handleKeyDown(index, e)}
            onPaste={handlePaste}
            onFocus={(e) => e.target.select()}
            className={cn(
              'h-12 w-10 rounded-[var(--radius-md)] border text-center text-lg font-semibold transition-all',
              'bg-[var(--color-bg)] text-[var(--color-fg)]',
              'focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-1',
              error
                ? 'border-[var(--color-danger)]'
                : 'border-[var(--color-border)]',
              disabled && 'cursor-not-allowed opacity-50',
            )}
            aria-label={`Digit ${index + 1} of ${length}`}
            aria-invalid={!!error}
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
          />
        ))}
      </div>
      {error && (
        <p className="text-center text-sm text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      )}
      {/* Shake animation */}
      <style jsx>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
          20%, 40%, 60%, 80% { transform: translateX(4px); }
        }
        .animate-shake {
          animation: shake 0.5s ease-in-out;
        }
      `}</style>
    </div>
  );
}
