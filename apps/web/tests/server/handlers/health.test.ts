/**
 * Tests for health handler.
 *
 * Status handler tests are in status.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';

import { handleHealthCheck } from '@/server/handlers';

import { buildReqCtx } from './helpers';

describe('handleHealthCheck', () => {
  it('returns 200 with ok status when DB is reachable', async () => {
    const ctx = buildReqCtx();
    // The health handler calls db.execute(sql`SELECT 1`) via dynamic import.
    // We need to provide an execute method on the mock DB.
    const db = ctx.db as unknown as { execute: ReturnType<typeof vi.fn> };
    db.execute = vi.fn().mockResolvedValue([{ '1': 1 }]);

    const res = await handleHealthCheck(ctx);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks).toBeInstanceOf(Array);
    expect(body.checks.length).toBe(1);
    expect(body.checks[0].name).toBe('database');
    expect(body.checks[0].ok).toBe(true);
    expect(body.uptimeSec).toBeTypeOf('number');
    expect(body.version).toBeTypeOf('string');
    expect(body.gitSha).toBeTypeOf('string');
  });

  it('returns 503 when DB check throws', async () => {
    const ctx = buildReqCtx();
    const db = ctx.db as unknown as { execute: ReturnType<typeof vi.fn> };
    db.execute = vi.fn().mockRejectedValue(new Error('connection refused'));

    const res = await handleHealthCheck(ctx);
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.ok).toBe(false);
    const dbCheck = body.checks.find((c: { name: string }) => c.name === 'database');
    expect(dbCheck).toBeDefined();
    expect(dbCheck.ok).toBe(false);
    expect(dbCheck.error).toBe('connection refused');
  });
});
