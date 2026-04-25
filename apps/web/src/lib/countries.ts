/**
 * ISO 3166-1 alpha-2 country list with localised display names.
 *
 * Backed by two zero-dep sources:
 *   - `libphonenumber-js` ships the canonical 2-letter code set
 *     (already a dependency for the phone-input component).
 *   - `Intl.DisplayNames` resolves each code to an English
 *     human-readable country name without shipping a JSON blob.
 *
 * The result is memoised on module load so selects / pickers don't
 * rebuild the list on every render.
 *
 * @module
 */

import { getCountries } from 'libphonenumber-js/max';

export interface CountryOption {
  readonly code: string;
  readonly name: string;
}

/**
 * Fallback display names for when `Intl.DisplayNames` is unavailable
 * (older runtime or exotic build target). The real values overwrite
 * these at module init; this map only keeps the list from becoming
 * bare 2-letter codes on degraded platforms.
 */
const MINIMAL_FALLBACK: Readonly<Record<string, string>> = Object.freeze({
  TR: 'Turkey',
  US: 'United States',
  GB: 'United Kingdom',
  DE: 'Germany',
  FR: 'France',
  NL: 'Netherlands',
  ES: 'Spain',
  IT: 'Italy',
});

function buildList(): readonly CountryOption[] {
  let displayNames: Intl.DisplayNames | null = null;
  try {
    displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    displayNames = null;
  }

  const codes = getCountries();
  const resolved: CountryOption[] = [];
  for (const code of codes) {
    let name: string | undefined;
    if (displayNames !== null) {
      try {
        name = displayNames.of(code);
      } catch {
        name = undefined;
      }
    }
    if (name === undefined || name === code) {
      name = MINIMAL_FALLBACK[code] ?? code;
    }
    resolved.push({ code, name });
  }

  resolved.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return Object.freeze(resolved);
}

export const COUNTRIES: readonly CountryOption[] = buildList();

/** Lookup helper — returns `undefined` for unknown codes. */
export function getCountryName(code: string): string | undefined {
  return COUNTRIES.find((c) => c.code === code.toUpperCase())?.name;
}
