/**
 * Observability config tests.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  getObservabilityConfig,
  loadObservabilityConfig,
  resetObservabilityConfigForTests,
} from '@/lib/observability/config';
import { ObservabilityError } from '@/lib/observability/errors';

afterEach(() => {
  resetObservabilityConfigForTests();
});

describe('loadObservabilityConfig', () => {
  it('returns defaults when env is empty', () => {
    const config = loadObservabilityConfig({});
    expect(config.logLevel).toBe('info');
    expect(config.prettyPrint).toBe(false);
    expect(config.otelEnabled).toBe(false);
    expect(config.otelServiceName).toBe('crivacy-api');
    expect(config.otelExporterEndpoint).toBe('http://localhost:4317');
    expect(config.metricsEnabled).toBe(true);
    expect(config.metricsPrefix).toBe('crivacy_');
  });

  it('enables pretty print in development', () => {
    const config = loadObservabilityConfig({ NODE_ENV: 'development' });
    expect(config.prettyPrint).toBe(true);
  });

  it('disables pretty print in production', () => {
    const config = loadObservabilityConfig({ NODE_ENV: 'production' });
    expect(config.prettyPrint).toBe(false);
  });

  it('parses LOG_LEVEL', () => {
    const config = loadObservabilityConfig({ LOG_LEVEL: 'debug' });
    expect(config.logLevel).toBe('debug');
  });

  it('parses OTEL_ENABLED=true', () => {
    const config = loadObservabilityConfig({ OTEL_ENABLED: 'true' });
    expect(config.otelEnabled).toBe(true);
  });

  it('parses OTEL_ENABLED=1', () => {
    const config = loadObservabilityConfig({ OTEL_ENABLED: '1' });
    expect(config.otelEnabled).toBe(true);
  });

  it('parses OTEL_ENABLED=false', () => {
    const config = loadObservabilityConfig({ OTEL_ENABLED: 'false' });
    expect(config.otelEnabled).toBe(false);
  });

  it('parses METRICS_ENABLED=false', () => {
    const config = loadObservabilityConfig({ METRICS_ENABLED: 'false' });
    expect(config.metricsEnabled).toBe(false);
  });

  it('parses custom OTEL_SERVICE_NAME', () => {
    const config = loadObservabilityConfig({ OTEL_SERVICE_NAME: 'my-service' });
    expect(config.otelServiceName).toBe('my-service');
  });

  it('parses custom OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    const config = loadObservabilityConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4317',
    });
    expect(config.otelExporterEndpoint).toBe('http://tempo:4317');
  });

  it('parses custom METRICS_PREFIX', () => {
    const config = loadObservabilityConfig({ METRICS_PREFIX: 'myapp_' });
    expect(config.metricsPrefix).toBe('myapp_');
  });

  it('rejects invalid LOG_LEVEL', () => {
    expect(() => loadObservabilityConfig({ LOG_LEVEL: 'verbose' })).toThrow(ObservabilityError);
  });

  it('rejects invalid METRICS_PREFIX', () => {
    expect(() => loadObservabilityConfig({ METRICS_PREFIX: 'BAD-PREFIX!' })).toThrow(
      ObservabilityError,
    );
  });

  it('rejects invalid OTEL_EXPORTER_OTLP_ENDPOINT', () => {
    expect(() => loadObservabilityConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' })).toThrow(
      ObservabilityError,
    );
  });

  it('returns frozen config', () => {
    const config = loadObservabilityConfig({});
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe('getObservabilityConfig', () => {
  it('returns cached config on second call', () => {
    const first = getObservabilityConfig();
    const second = getObservabilityConfig();
    expect(first).toBe(second);
  });

  it('returns fresh config after reset', () => {
    const first = getObservabilityConfig();
    resetObservabilityConfigForTests();
    const second = getObservabilityConfig();
    // Both should have same defaults but be different references
    expect(first).not.toBe(second);
    expect(first.logLevel).toBe(second.logLevel);
  });
});
