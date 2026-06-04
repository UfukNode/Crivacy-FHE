'use client';

import * as React from 'react';
import PhoneInputWithCountry, {
  getCountries,
  getCountryCallingCode,
} from 'react-phone-number-input/max';
import type { Country } from 'react-phone-number-input';
import 'react-phone-number-input/style.css';
import { cn } from '@/lib/utils';
import { parsePhoneNumber } from '@/lib/validation/profile';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface PhoneInputProps {
  /** Current value in E.164 format (e.g. "+14155552671"). */
  value: string | undefined;
  /** Called when the value changes. Receives E.164 string or undefined. */
  onChange: (value: string | undefined) => void;
  /** ISO 3166-1 alpha-2 default country code (e.g. "US"). */
  defaultCountry?: Country;
  /** Error message to display below the input. */
  error?: string;
  /** Whether the input is disabled. */
  disabled?: boolean;
  /** Additional CSS classes for the outer wrapper. */
  className?: string;
  /** Placeholder text. */
  placeholder?: string;
}

/* -------------------------------------------------------------------------- */
/*  Re-export validation for use in forms                                     */
/* -------------------------------------------------------------------------- */

export { isValidPhoneNumber } from '@/lib/validation/profile';

/* -------------------------------------------------------------------------- */
/*  Per-country max national number length                                    */
/* -------------------------------------------------------------------------- */

/**
 * Compute the maximum valid national number length for a given country
 * by probing `isValid()` across all digit patterns (0-9) at lengths 1-15.
 *
 * Falls back to E.164 max (15 minus calling code length) when no valid
 * pattern is found (e.g. countries with only special/service numbers).
 */
function computeMaxNationalLength(country: Country): number {
  const cc = getCountryCallingCode(country);
  let maxLen = 0;
  for (let len = 1; len <= 15; len++) {
    for (let d = 0; d <= 9; d++) {
      try {
        const parsed = parsePhoneNumber(`+${cc}${String(d).repeat(len)}`);
        if (parsed?.isValid() && len > maxLen) {
          maxLen = len;
        }
      } catch {
        // skip unparseable combinations
      }
    }
  }
  // Fallback: E.164 allows max 15 digits total (including calling code)
  return maxLen > 0 ? maxLen : 15 - cc.length;
}

/** Memoization cache, computed once per country, reused across renders. */
const maxLengthCache = new Map<Country, number>();

function getMaxNationalLength(country: Country): number {
  const cached = maxLengthCache.get(country);
  if (cached !== undefined) return cached;
  const len = computeMaxNationalLength(country);
  maxLengthCache.set(country, len);
  return len;
}

// Pre-warm cache for all countries on module load (runs once in browser).
if (typeof window !== 'undefined') {
  // Use requestIdleCallback to avoid blocking the main thread.
  const warmup = () => {
    for (const c of getCountries()) {
      getMaxNationalLength(c);
    }
  };
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(warmup);
  } else {
    setTimeout(warmup, 2000);
  }
}

/* -------------------------------------------------------------------------- */
/*  Browser locale → country code                                             */
/* -------------------------------------------------------------------------- */

/**
 * Derive country code from browser locale. Returns undefined if detection
 * fails, no hardcoded fallback.
 */
function detectCountryFromLocale(): Country | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const lang = navigator.language;
  if (lang.length >= 5 && lang[2] === '-') {
    const region = lang.slice(3, 5).toUpperCase();
    if (/^[A-Z]{2}$/.test(region)) {
      return region as Country;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Phone number input with country selector dropdown.
 *
 * Uses `react-phone-number-input` full component which provides:
 * - Country flag dropdown with search
 * - Auto-detection of country from pasted numbers
 * - Trunk prefix stripping (e.g. leading zero removal)
 * - E.164 output format
 *
 * Per-country digit limit is enforced via `isValid()` metadata from
 * `libphonenumber-js/max`, the library's built-in `limitMaxLength`
 * relies on `isPossible()` which is too permissive.
 *
 * No hardcoded country fallbacks, detects from browser locale,
 * falls back to international mode if detection fails.
 */
export function PhoneInput({
  value,
  onChange,
  defaultCountry,
  error,
  disabled = false,
  className,
  placeholder,
}: PhoneInputProps) {
  const resolvedCountry = defaultCountry ?? detectCountryFromLocale();
  const [selectedCountry, setSelectedCountry] = React.useState<Country | undefined>(resolvedCountry);

  // Track max total digits (cc + national) for the current country.
  // Used by DigitLimitedInput to block excess keystrokes at the input level.
  const maxTotalDigitsRef = React.useRef(15);

  React.useEffect(() => {
    if (selectedCountry !== undefined) {
      const cc = getCountryCallingCode(selectedCountry);
      maxTotalDigitsRef.current = cc.length + getMaxNationalLength(selectedCountry);
    } else {
      maxTotalDigitsRef.current = 15;
    }
  }, [selectedCountry]);

  // Custom input component that prevents typing/pasting digits beyond the
  // per-country maximum. This stops the library's AsYouType formatter from
  // silently truncating excess digits before our onChange ever sees them.
  // eslint-disable-next-line react/display-name -- anonymous forwardRef inside useMemo is fine
  const DigitLimitedInput = React.useMemo(
    () =>
      React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
        function DigitLimitedInput(props, ref) {
          return (
            <input
              {...props}
              ref={ref}
              onBeforeInput={(e) => {
                const native = e.nativeEvent as InputEvent;
                const data = native.data;
                if (!data) return;

                const insertDigitCount = data.replace(/\D/g, '').length;
                if (insertDigitCount === 0) return;

                const currentDigitCount = (e.currentTarget.value ?? '').replace(/\D/g, '').length;
                if (currentDigitCount + insertDigitCount > maxTotalDigitsRef.current) {
                  e.preventDefault();
                }
              }}
            />
          );
        },
      ),
    [],
  );

  // When a country is resolved, enable international mode with locked
  // calling code. When no country is detected (e.g. SSR or unsupported
  // locale), fall back to plain international mode without a default.
  const countryProps = resolvedCountry !== undefined
    ? { international: true as const, countryCallingCodeEditable: false as const, defaultCountry: resolvedCountry }
    : {};

  const handleChange = React.useCallback(
    (newVal: string | undefined) => {
      if (newVal !== undefined && newVal.length > 0 && selectedCountry !== undefined) {
        // Use raw digit counting, NOT parsePhoneNumber, because the parser
        // silently truncates excess digits, making the check always pass.
        const cc = getCountryCallingCode(selectedCountry);
        const allDigits = newVal.replace(/\D/g, '');
        const nationalDigitCount = allDigits.startsWith(cc)
          ? allDigits.length - cc.length
          : allDigits.length;
        const maxLen = getMaxNationalLength(selectedCountry);

        if (nationalDigitCount > maxLen) {
          return;
        }
      }
      onChange(newVal ?? undefined);
    },
    [onChange, selectedCountry],
  );

  const handleCountryChange = React.useCallback((country: Country) => {
    setSelectedCountry(country);
  }, []);

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <PhoneInputWithCountry
        {...countryProps}
        inputComponent={DigitLimitedInput}
        value={value ?? ''}
        onChange={handleChange}
        onCountryChange={handleCountryChange}
        placeholder={placeholder ?? 'Enter phone number'}
        disabled={disabled}
        flagUrl="/flags/3x2/{XX}.svg"
        className={cn(
          'crivacy-phone-input',
          error ? 'crivacy-phone-input--error' : '',
        )}
      />
      {error !== undefined && error.length > 0 && (
        <p className="text-xs text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
