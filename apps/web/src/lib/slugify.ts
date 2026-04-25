/**
 * Slug normalisation helper used by firm create forms and any other
 * place where a human-typed name needs to become a stable URL-safe
 * identifier.
 *
 * Rules:
 *   - NFKD-normalise + strip combining marks so `Ş` → `S`, `ü` → `u`
 *     etc. without locale-specific surprises (Turkish İ → I, Almanya
 *     ß → ss via a targeted map).
 *   - Lowercase.
 *   - Collapse any run of non-[a-z0-9] into a single hyphen.
 *   - Trim leading / trailing hyphens.
 *   - Cap the length at `maxLength` (default 48) so we stay well
 *     under any DB `varchar` limit.
 *
 * @module
 */

/**
 * Targeted replacements applied BEFORE the generic normalisation.
 * `NFKD` would drop combining marks but leave `ß` intact, which is
 * wrong for a slug — we want `ss`. Ditto Scandinavian digraphs.
 */
const PRE_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  å: 'a',
  ı: 'i',
  İ: 'I',
});

export function slugify(input: string, maxLength = 48): string {
  if (typeof input !== 'string' || input.length === 0) return '';

  let s = input;
  for (const [from, to] of Object.entries(PRE_REPLACEMENTS)) {
    s = s.split(from).join(to);
  }

  // Strip combining marks (accents) after NFKD normalisation. The
  // `/\p{M}/gu` range covers every Unicode "Mark" general category.
  s = s.normalize('NFKD').replace(/\p{M}/gu, '');

  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  if (s.length > maxLength) {
    s = s.slice(0, maxLength).replace(/-+$/g, '');
  }

  return s;
}
