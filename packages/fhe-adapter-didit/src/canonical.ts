/**
 * Canonical JSON serialization for Didit webhook HMAC verification.
 *
 * Didit's upstream webhook dispatcher builds its HMAC over a
 * canonicalized form of the webhook payload. Two non-obvious
 * normalizations are applied server-side that we MUST reproduce
 * byte-for-byte, or every legitimate webhook will fail our HMAC
 * check:
 *
 *   1. **`shortenFloats`** — JSON floats that are whole numbers
 *      (`42.0`, `100.0`, etc.) are coerced to integers before
 *      serialization. Python's `json.dumps(42.0)` emits `"42.0"`,
 *      but the Didit server applies `int(value)` when the value is
 *      a whole number, so the wire form seen by the HMAC is `"42"`.
 *      The same pass also trims trailing zeros from `%f`-style
 *      integer-valued decimals. Non-integer floats pass through
 *      unchanged.
 *
 *   2. **`sortKeys`** — every object is serialized with its keys
 *      sorted lexicographically (ASCII code point order). Nested
 *      objects are sorted recursively. Arrays preserve order.
 *
 * The combined pipeline is
 *
 *     canonicalJson(data) === JSON.stringify(sortKeys(shortenFloats(data)))
 *
 * `sortKeys` returns a fresh object so we do not mutate the caller's
 * payload. `shortenFloats` also returns a fresh value — critical
 * because the parsed webhook body is the body we hand to the worker
 * queue, and mutating it in-place would corrupt downstream consumers.
 *
 * These two helpers live in their own module (not inside `webhook.ts`)
 * so the unit tests can pin the exact normalization behavior
 * separately from the HMAC math: any future Didit server-side tweak
 * surfaces as a single test failure here.
 */

/* ---------- shortenFloats ---------- */

/**
 * Recursively normalize whole-number floats to integers.
 *
 * Behavior on each JSON type:
 *
 *   * `number`  — if the value is finite and `Number.isInteger(value)`
 *                 is false while `value % 1 === 0`, truncate to the
 *                 integer. This matches the Python behavior where
 *                 `100.0 % 1 == 0` → coerced to `100`. Non-integer
 *                 floats (`0.5`, `3.14`) pass through unchanged.
 *   * `array`   — walk every element and rebuild.
 *   * `object`  — walk every value and rebuild, preserving keys.
 *   * `null`    — passes through unchanged.
 *   * `string`  — passes through unchanged.
 *   * `boolean` — passes through unchanged.
 *
 * Non-JSON types (undefined, function, symbol, bigint) are not
 * expected in a parsed JSON body. We coerce them to `null` to
 * preserve the JSON invariant and fail loudly downstream if a caller
 * accidentally hands us a non-JSON tree.
 */
export function shortenFloats(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(shortenFloats);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      result[key] = shortenFloats(inner);
    }
    return result;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      // NaN / Infinity are not legal JSON. Leave them for the outer
      // serializer to fail on so the caller gets a clean error.
      return value;
    }
    if (!Number.isInteger(value) && value % 1 === 0) {
      return Math.trunc(value);
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    return value;
  }
  // bigint / symbol / function / undefined — coerce to null so the
  // canonical JSON does not carry garbage.
  return null;
}

/* ---------- sortKeys ---------- */

/**
 * Recursively rebuild a JSON-like value with object keys sorted in
 * lexicographic (ASCII) order. Arrays are walked in order, scalars
 * pass through unchanged. Matches Python's
 * `json.dumps(obj, sort_keys=True)` for plain dict/list trees, which
 * is what Didit's dispatcher uses.
 *
 * Implementation notes:
 *
 *   * `Object.keys(o).sort()` on a plain object uses the default
 *     `String#localeCompare`? No — `.sort()` with no comparator
 *     compares via `String(x) < String(y)`, which is ASCII order for
 *     ASCII keys and consistent across V8 versions. Python uses the
 *     same byte-order compare for ASCII keys, so the serialized
 *     output matches.
 *
 *   * We return a fresh object so the caller retains its original
 *     map intact. `JSON.stringify` on the returned object then emits
 *     keys in insertion order, which after the sort IS lexicographic.
 */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      result[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/* ---------- Combined pipeline ---------- */

/**
 * Serialize a parsed JSON body to the exact byte string Didit
 * HMAC'd before attaching `X-Signature-V2`. This is `JSON.stringify`
 * after `shortenFloats` + `sortKeys`, with no trailing newline and
 * no extra whitespace.
 *
 * `JSON.stringify` already emits the tight form (`,` + `:` with no
 * spaces) by default when called without the `space` argument, so
 * we do not need to tweak the separators. Python's
 * `json.dumps(obj, separators=(',', ':'), sort_keys=True)` matches
 * byte-for-byte.
 *
 * Throws a plain `TypeError` (not `DiditError`) if the input cannot
 * be serialized — the caller (`webhook.verifyWebhookSignature`)
 * wraps it in a `DiditError('invalid_webhook_body', …)`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(shortenFloats(value)));
}
