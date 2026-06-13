/**
 * Tests for the request parsing utilities.
 *
 * Covers:
 *   * `parseBody` — content-type guard, size enforcement, JSON parse,
 *     Zod validation, error types
 *   * `parseQuery` — single values, duplicate keys → array, Zod validation
 *   * `parsePathParams` — awaits promise, Zod validation
 *   * `ParseError` + `isParseError` type guard
 */

import { describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';

import {
  ParseError,
  isParseError,
  parseBody,
  parsePathParams,
  parseQuery,
} from '@/server/middleware/parse';

import { buildTestRequest } from './fixtures';

/* ================================================================== */
/*  ParseError                                                         */
/* ================================================================== */

describe('ParseError', () => {
  it('sets the code and message', () => {
    const err = new ParseError('malformed_json', 'bad json');
    expect(err.code).toBe('malformed_json');
    expect(err.message).toBe('bad json');
    expect(err.name).toBe('ParseError');
  });

  it('is an instance of Error', () => {
    expect(new ParseError('payload_too_large', 'too big')).toBeInstanceOf(Error);
  });

  it('preserves cause', () => {
    const cause = new SyntaxError('Unexpected token');
    const err = new ParseError('malformed_json', 'bad', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('isParseError', () => {
  it('returns true for a ParseError', () => {
    expect(isParseError(new ParseError('malformed_json', 'x'))).toBe(true);
  });

  it('returns false for a plain Error', () => {
    expect(isParseError(new Error('x'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isParseError(null)).toBe(false);
  });
});

/* ================================================================== */
/*  parseBody                                                          */
/* ================================================================== */

describe('parseBody', () => {
  const TestSchema = z.object({
    name: z.string().min(1),
    age: z.number().int().min(0),
  });

  // Helper that builds a request with a real JSON body.
  function buildJsonRequestWithBody(body: unknown): ReturnType<typeof buildTestRequest> {
    const json = JSON.stringify(body);
    const headers = new Headers({
      'content-type': 'application/json',
      'content-length': String(new TextEncoder().encode(json).byteLength),
    });
    const req = new Request('https://api.crivacy.test/api/v1/sessions', {
      method: 'POST',
      headers,
      body: json,
    });
    // NextRequest wraps a Request.
    const { NextRequest } = require('next/server') as typeof import('next/server');
    return new NextRequest(req);
  }

  it('parses a valid JSON body', async () => {
    const req = buildJsonRequestWithBody({ name: 'Ada', age: 36 });
    const result = await parseBody(req, TestSchema);
    expect(result.name).toBe('Ada');
    expect(result.age).toBe(36);
  });

  it('throws ParseError(unsupported_media_type) when content-type is missing', async () => {
    const req = buildTestRequest({ method: 'POST' });
    try {
      await parseBody(req, TestSchema);
      expect.unreachable();
    } catch (err) {
      expect(isParseError(err)).toBe(true);
      expect((err as ParseError).code).toBe('unsupported_media_type');
    }
  });

  it('throws ParseError(unsupported_media_type) when content-type is text/plain', async () => {
    const req = buildTestRequest({
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
    });
    try {
      await parseBody(req, TestSchema);
      expect.unreachable();
    } catch (err) {
      expect(isParseError(err)).toBe(true);
      expect((err as ParseError).code).toBe('unsupported_media_type');
    }
  });

  it('accepts content-type with charset suffix', async () => {
    const json = JSON.stringify({ name: 'Bob', age: 25 });
    const req = new (require('next/server') as typeof import('next/server')).NextRequest(
      new Request('https://api.crivacy.test/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: json,
      }),
    );
    const result = await parseBody(req, TestSchema);
    expect(result.name).toBe('Bob');
  });

  it('throws ParseError(malformed_json) on invalid JSON', async () => {
    const req = new (require('next/server') as typeof import('next/server')).NextRequest(
      new Request('https://api.crivacy.test/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json{{{',
      }),
    );
    try {
      await parseBody(req, TestSchema);
      expect.unreachable();
    } catch (err) {
      expect(isParseError(err)).toBe(true);
      expect((err as ParseError).code).toBe('malformed_json');
    }
  });

  it('throws ZodError when schema validation fails', async () => {
    const req = buildJsonRequestWithBody({ name: '', age: -1 });
    try {
      await parseBody(req, TestSchema);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
    }
  });

  it('throws ParseError(payload_too_large) when Content-Length exceeds limit', async () => {
    const json = JSON.stringify({ name: 'X'.repeat(100), age: 1 });
    const req = new (require('next/server') as typeof import('next/server')).NextRequest(
      new Request('https://api.crivacy.test/test', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '999999',
        },
        body: json,
      }),
    );
    try {
      await parseBody(req, TestSchema, 64);
      expect.unreachable();
    } catch (err) {
      expect(isParseError(err)).toBe(true);
      expect((err as ParseError).code).toBe('payload_too_large');
    }
  });

  it('throws ParseError(payload_too_large) when actual body exceeds limit', async () => {
    const bigBody = JSON.stringify({ name: 'X'.repeat(200), age: 1 });
    const req = new (require('next/server') as typeof import('next/server')).NextRequest(
      new Request('https://api.crivacy.test/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bigBody,
      }),
    );
    try {
      await parseBody(req, TestSchema, 64);
      expect.unreachable();
    } catch (err) {
      expect(isParseError(err)).toBe(true);
      expect((err as ParseError).code).toBe('payload_too_large');
    }
  });

  it('accepts a body exactly at the limit', async () => {
    const body = { name: 'A', age: 1 };
    const json = JSON.stringify(body);
    const byteLen = new TextEncoder().encode(json).byteLength;
    const req = buildJsonRequestWithBody(body);
    const result = await parseBody(req, TestSchema, byteLen);
    expect(result.name).toBe('A');
  });
});

/* ================================================================== */
/*  parseQuery                                                         */
/* ================================================================== */

describe('parseQuery', () => {
  const QuerySchema = z.object({
    limit: z
      .string()
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().min(1).max(100))
      .optional(),
    cursor: z.string().optional(),
  });

  it('parses a simple query string', () => {
    const url = new URL('https://api.crivacy.test/api/v1/sessions?limit=25&cursor=abc');
    const result = parseQuery(url, QuerySchema);
    expect(result.limit).toBe(25);
    expect(result.cursor).toBe('abc');
  });

  it('omits absent keys', () => {
    const url = new URL('https://api.crivacy.test/api/v1/sessions');
    const result = parseQuery(url, QuerySchema);
    expect(result.limit).toBeUndefined();
    expect(result.cursor).toBeUndefined();
  });

  it('coerces duplicate keys to arrays', () => {
    const ArraySchema = z.object({
      tag: z.union([z.string(), z.array(z.string())]),
    });
    const url = new URL('https://api.crivacy.test/test?tag=a&tag=b');
    const result = parseQuery(url, ArraySchema);
    expect(result.tag).toEqual(['a', 'b']);
  });

  it('keeps single-value keys as strings', () => {
    const ArraySchema = z.object({
      tag: z.union([z.string(), z.array(z.string())]),
    });
    const url = new URL('https://api.crivacy.test/test?tag=solo');
    const result = parseQuery(url, ArraySchema);
    expect(result.tag).toBe('solo');
  });

  it('throws ZodError on validation failure', () => {
    const url = new URL('https://api.crivacy.test/test?limit=abc');
    expect(() => parseQuery(url, QuerySchema)).toThrow(ZodError);
  });
});

/* ================================================================== */
/*  parsePathParams                                                    */
/* ================================================================== */

describe('parsePathParams', () => {
  const ParamsSchema = z.object({
    id: z.string().uuid(),
  });

  it('awaits and validates path params', async () => {
    const params = Promise.resolve({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const result = await parsePathParams(params, ParamsSchema);
    expect(result.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('throws ZodError on invalid params', async () => {
    const params = Promise.resolve({ id: 'not-a-uuid' });
    try {
      await parsePathParams(params, ParamsSchema);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
    }
  });

  it('throws ZodError on missing params', async () => {
    const params = Promise.resolve({} as Record<string, string>);
    try {
      await parsePathParams(params, ParamsSchema);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
    }
  });
});
