/**
 * Logger tests.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';

import { resetObservabilityConfigForTests } from '@/lib/observability/config';
import {
  childLogger,
  createLogger,
  getRootLogger,
  resetRootLoggerForTests,
} from '@/lib/observability/logger';

afterEach(() => {
  resetRootLoggerForTests();
  resetObservabilityConfigForTests();
});

describe('createLogger', () => {
  it('creates a pino logger with info level by default', () => {
    const logger = createLogger({
      logLevel: 'info',
      prettyPrint: false,
      otelEnabled: false,
      otelServiceName: 'test',
      otelExporterEndpoint: 'http://localhost:4317',
      metricsEnabled: false,
      metricsPrefix: 'test_',
    });
    expect(logger).toBeDefined();
    expect(logger.level).toBe('info');
  });

  it('respects custom log level', () => {
    const logger = createLogger({
      logLevel: 'debug',
      prettyPrint: false,
      otelEnabled: false,
      otelServiceName: 'test',
      otelExporterEndpoint: 'http://localhost:4317',
      metricsEnabled: false,
      metricsPrefix: 'test_',
    });
    expect(logger.level).toBe('debug');
  });

  it('creates logger with warn level', () => {
    const logger = createLogger({
      logLevel: 'warn',
      prettyPrint: false,
      otelEnabled: false,
      otelServiceName: 'test',
      otelExporterEndpoint: 'http://localhost:4317',
      metricsEnabled: false,
      metricsPrefix: 'test_',
    });
    expect(logger.level).toBe('warn');
  });

  it('creates logger with silent level', () => {
    const logger = createLogger({
      logLevel: 'silent',
      prettyPrint: false,
      otelEnabled: false,
      otelServiceName: 'test',
      otelExporterEndpoint: 'http://localhost:4317',
      metricsEnabled: false,
      metricsPrefix: 'test_',
    });
    expect(logger.level).toBe('silent');
  });
});

describe('childLogger', () => {
  it('creates a child with requestId binding', () => {
    const parent = createLogger({
      logLevel: 'silent',
      prettyPrint: false,
      otelEnabled: false,
      otelServiceName: 'test',
      otelExporterEndpoint: 'http://localhost:4317',
      metricsEnabled: false,
      metricsPrefix: 'test_',
    });
    const child = childLogger(parent, { requestId: 'req-1' });
    expect(child).toBeDefined();
    // Child inherits parent level
    expect(child.level).toBe('silent');
  });

  it('creates a child with full context', () => {
    const parent = createLogger({
      logLevel: 'silent',
      prettyPrint: false,
      otelEnabled: false,
      otelServiceName: 'test',
      otelExporterEndpoint: 'http://localhost:4317',
      metricsEnabled: false,
      metricsPrefix: 'test_',
    });
    const child = childLogger(parent, {
      requestId: 'req-1',
      firmId: 'firm-1',
      apiKeyId: 'key-1',
      method: 'POST',
      path: '/api/v1/sessions',
      ip: '10.0.0.1',
    });
    expect(child).toBeDefined();
  });

  it('skips null ip', () => {
    const parent = createLogger({
      logLevel: 'silent',
      prettyPrint: false,
      otelEnabled: false,
      otelServiceName: 'test',
      otelExporterEndpoint: 'http://localhost:4317',
      metricsEnabled: false,
      metricsPrefix: 'test_',
    });
    // This should not throw
    const child = childLogger(parent, { ip: null });
    expect(child).toBeDefined();
  });

  it('skips undefined fields', () => {
    const parent = createLogger({
      logLevel: 'silent',
      prettyPrint: false,
      otelEnabled: false,
      otelServiceName: 'test',
      otelExporterEndpoint: 'http://localhost:4317',
      metricsEnabled: false,
      metricsPrefix: 'test_',
    });
    // All fields undefined — should still create a valid child
    const child = childLogger(parent, {});
    expect(child).toBeDefined();
  });
});

describe('getRootLogger', () => {
  it('returns same instance on multiple calls', () => {
    const a = getRootLogger();
    const b = getRootLogger();
    expect(a).toBe(b);
  });

  it('returns fresh instance after reset', () => {
    const a = getRootLogger();
    resetRootLoggerForTests();
    const b = getRootLogger();
    expect(a).not.toBe(b);
  });
});
