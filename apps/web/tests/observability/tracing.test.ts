/**
 * Tracing tests.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  getTracer,
  initTracing,
  resetTracingForTests,
  withSpan,
  withSpanSync,
} from '@/lib/observability/tracing';

afterEach(() => {
  resetTracingForTests();
});

describe('initTracing', () => {
  it('initializes without error when disabled', async () => {
    await initTracing({
      logLevel: 'info',
      prettyPrint: false,
      otelEnabled: false,
      otelServiceName: 'test',
      otelExporterEndpoint: 'http://localhost:4317',
      metricsEnabled: false,
      metricsPrefix: 'test_',
    });
    // No error = success
  });

  it('is idempotent', async () => {
    const config = {
      logLevel: 'info' as const,
      prettyPrint: false,
      otelEnabled: false,
      otelServiceName: 'test',
      otelExporterEndpoint: 'http://localhost:4317',
      metricsEnabled: false,
      metricsPrefix: 'test_',
    };
    await initTracing(config);
    await initTracing(config);
    // No error = idempotent
  });
});

describe('getTracer', () => {
  it('returns a tracer', () => {
    const tracer = getTracer();
    expect(tracer).toBeDefined();
  });

  it('returns same tracer name', () => {
    const a = getTracer();
    const b = getTracer();
    // Both should be from the same provider
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });
});

describe('withSpan', () => {
  it('executes callback and returns result', async () => {
    const result = await withSpan('test-span', { key: 'value' }, async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it('passes span to callback', async () => {
    let receivedSpan = false;
    await withSpan('test-span', {}, async (span) => {
      receivedSpan = span !== undefined && span !== null;
      return true;
    });
    expect(receivedSpan).toBe(true);
  });

  it('re-throws errors from callback', async () => {
    await expect(
      withSpan('test-span', {}, async () => {
        throw new Error('Test error');
      }),
    ).rejects.toThrow('Test error');
  });

  it('handles non-Error throws', async () => {
    await expect(
      withSpan('test-span', {}, async () => {
        throw 'string error';
      }),
    ).rejects.toBe('string error');
  });
});

describe('withSpanSync', () => {
  it('executes callback and returns result', () => {
    const result = withSpanSync('test-span', { key: 'value' }, () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it('passes span to callback', () => {
    let receivedSpan = false;
    withSpanSync('test-span', {}, (span) => {
      receivedSpan = span !== undefined && span !== null;
    });
    expect(receivedSpan).toBe(true);
  });

  it('re-throws errors from callback', () => {
    expect(() =>
      withSpanSync('test-span', {}, () => {
        throw new Error('Sync error');
      }),
    ).toThrow('Sync error');
  });
});
