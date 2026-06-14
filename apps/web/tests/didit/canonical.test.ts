/**
 * Tests for canonical JSON serialization used by webhook HMAC.
 *
 * These tests pin the exact normalization behavior so any future
 * Didit server-side tweak surfaces as a single failure here. The
 * two critical properties:
 *
 *   * `shortenFloats` coerces whole-number floats to integers
 *     (matching Python `json.dumps(int(42.0))` → `"42"`).
 *   * `sortKeys` emits object keys in lexicographic order, so
 *     `canonicalJson({b: 1, a: 2})` === `canonicalJson({a: 2, b: 1})`.
 */

import { describe, expect, it } from 'vitest';

import { canonicalJson, shortenFloats, sortKeys } from '@crivacy-fhe/adapter-didit';

describe('shortenFloats', () => {
  it('passes through integers unchanged', () => {
    expect(shortenFloats(0)).toBe(0);
    expect(shortenFloats(42)).toBe(42);
    expect(shortenFloats(-7)).toBe(-7);
  });

  it('coerces whole-number floats to integers', () => {
    expect(shortenFloats(42.0)).toBe(42);
    expect(shortenFloats(100.0)).toBe(100);
  });

  it('preserves non-integer floats', () => {
    expect(shortenFloats(0.5)).toBe(0.5);
    expect(shortenFloats(3.14)).toBe(3.14);
    expect(shortenFloats(99.6)).toBe(99.6);
  });

  it('passes through strings, booleans, and null unchanged', () => {
    expect(shortenFloats('hello')).toBe('hello');
    expect(shortenFloats(true)).toBe(true);
    expect(shortenFloats(false)).toBe(false);
    expect(shortenFloats(null)).toBe(null);
  });

  it('walks arrays recursively', () => {
    expect(shortenFloats([1.0, 2.5, 3.0])).toEqual([1, 2.5, 3]);
    expect(shortenFloats([[1.0], [2.0]])).toEqual([[1], [2]]);
  });

  it('walks plain objects recursively', () => {
    expect(shortenFloats({ a: 1.0, b: 2.5, c: 3.0 })).toEqual({ a: 1, b: 2.5, c: 3 });
  });

  it('walks nested arrays + objects together', () => {
    const input = { outer: [{ inner: 42.0 }], tail: [1.0, { x: 2.0 }] };
    expect(shortenFloats(input)).toEqual({ outer: [{ inner: 42 }], tail: [1, { x: 2 }] });
  });

  it('does not mutate the input object', () => {
    const input = { a: 1.0, nested: { b: 2.0 } };
    shortenFloats(input);
    expect(input).toEqual({ a: 1.0, nested: { b: 2.0 } });
  });

  it('preserves NaN and Infinity (leaves them for JSON.stringify to reject)', () => {
    expect(Number.isNaN(shortenFloats(Number.NaN) as number)).toBe(true);
    expect(shortenFloats(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('coerces bigints / symbols / functions / undefined to null', () => {
    expect(shortenFloats(1n)).toBe(null);
    expect(shortenFloats(Symbol('s'))).toBe(null);
    expect(shortenFloats(() => undefined)).toBe(null);
    expect(shortenFloats(undefined)).toBe(null);
  });
});

describe('sortKeys', () => {
  it('passes through scalars unchanged', () => {
    expect(sortKeys(42)).toBe(42);
    expect(sortKeys('x')).toBe('x');
    expect(sortKeys(true)).toBe(true);
    expect(sortKeys(null)).toBe(null);
  });

  it('sorts top-level object keys lexicographically', () => {
    const sorted = sortKeys({ b: 1, a: 2, c: 3 });
    expect(Object.keys(sorted as object)).toEqual(['a', 'b', 'c']);
  });

  it('sorts nested object keys recursively', () => {
    const sorted = sortKeys({
      outer: { z: 1, a: 2, m: 3 },
    }) as { outer: Record<string, number> };
    expect(Object.keys(sorted.outer)).toEqual(['a', 'm', 'z']);
  });

  it('preserves array order', () => {
    expect(sortKeys([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('sorts keys inside objects embedded in arrays', () => {
    const sorted = sortKeys([{ b: 1, a: 2 }]) as Array<Record<string, number>>;
    const first = sorted[0];
    if (first === undefined) {
      throw new Error('expected first element');
    }
    expect(Object.keys(first)).toEqual(['a', 'b']);
  });

  it('does not mutate the input object', () => {
    const input = { b: 1, a: 2 };
    sortKeys(input);
    expect(Object.keys(input)).toEqual(['b', 'a']);
  });
});

describe('canonicalJson', () => {
  it('produces identical output regardless of key order', () => {
    const a = canonicalJson({ a: 1, b: 2 });
    const b = canonicalJson({ b: 2, a: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2}');
  });

  it('coerces whole-number floats before serializing', () => {
    expect(canonicalJson({ score: 95.0 })).toBe('{"score":95}');
  });

  it('preserves non-integer floats', () => {
    expect(canonicalJson({ score: 99.6 })).toBe('{"score":99.6}');
  });

  it('uses tight separators (no whitespace)', () => {
    const out = canonicalJson({ a: 1, b: [2, 3] });
    expect(out).toBe('{"a":1,"b":[2,3]}');
    expect(out).not.toContain(' ');
  });

  it('recursively sorts nested objects', () => {
    expect(canonicalJson({ b: { z: 1, a: 2 }, a: 1 })).toBe('{"a":1,"b":{"a":2,"z":1}}');
  });

  it('serializes null and booleans correctly', () => {
    expect(canonicalJson({ a: null, b: true, c: false })).toBe('{"a":null,"b":true,"c":false}');
  });

  it('matches Python json.dumps(..., sort_keys=True, separators=(",",":")) for a complex tree', () => {
    const input = {
      workflow_id: '2ab9f298-699c-4b2c-9ce9-6246c17c6c25',
      status: 'Approved',
      session_id: 'sess_1',
      vendor_data: 'user_a',
      human_score: 95.0,
      kyc: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        document_number: 'P123',
      },
    };
    // Expected: keys sorted at every level, 95.0 → 95, tight separators.
    const expected =
      '{"human_score":95,"kyc":{"document_number":"P123","first_name":"Ada","last_name":"Lovelace"},"session_id":"sess_1","status":"Approved","vendor_data":"user_a","workflow_id":"2ab9f298-699c-4b2c-9ce9-6246c17c6c25"}';
    expect(canonicalJson(input)).toBe(expected);
  });

  it('is stable across call order', () => {
    const input = { kyc: { b: 1, a: 2 } };
    const first = canonicalJson(input);
    const second = canonicalJson(input);
    expect(first).toBe(second);
  });
});
