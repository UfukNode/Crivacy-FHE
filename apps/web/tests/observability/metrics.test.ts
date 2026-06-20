/**
 * Metrics tests.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  auditEventsTotal,
  authAttemptsTotal,
  chainSubmitDurationSeconds,
  chainSubmitErrorsTotal,
  dbQueryDurationSeconds,
  getRegistry,
  httpRequestDurationSeconds,
  httpRequestSizeBytes,
  httpRequestsTotal,
  httpResponseSizeBytes,
  initDefaultMetrics,
  kycSessionOutcomesTotal,
  kycSessionsCreatedTotal,
  quotaUsageRatio,
  rateLimitDenialsTotal,
  resetMetricsForTests,
  webhookCircuitBreakersOpen,
  webhookDeliveriesTotal,
  webhookDeliveryDurationSeconds,
} from '@/lib/observability/metrics';

afterEach(() => {
  resetMetricsForTests();
});

describe('getRegistry', () => {
  it('returns a registry', () => {
    const registry = getRegistry();
    expect(registry).toBeDefined();
  });

  it('returns the same registry', () => {
    const a = getRegistry();
    const b = getRegistry();
    expect(a).toBe(b);
  });
});

describe('initDefaultMetrics', () => {
  it('can be called multiple times (idempotent)', () => {
    const config = {
      logLevel: 'info' as const,
      prettyPrint: false,
      otelEnabled: false,
      otelServiceName: 'test',
      otelExporterEndpoint: 'http://localhost:4317',
      metricsEnabled: true,
      metricsPrefix: 'test_',
    };
    initDefaultMetrics(config);
    initDefaultMetrics(config);
    // No error thrown = idempotent
  });

  it('does nothing when metricsEnabled is false', () => {
    const config = {
      logLevel: 'info' as const,
      prettyPrint: false,
      otelEnabled: false,
      otelServiceName: 'test',
      otelExporterEndpoint: 'http://localhost:4317',
      metricsEnabled: false,
      metricsPrefix: 'test_',
    };
    initDefaultMetrics(config);
    // No default metrics registered when disabled
  });
});

describe('HTTP metrics', () => {
  it('httpRequestsTotal increments', async () => {
    httpRequestsTotal.inc({ method: 'GET', path: '/test', status: '200', auth_tier: 'public' });
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_http_requests_total');
    expect(metric).toBeDefined();
  });

  it('httpRequestDurationSeconds observes', async () => {
    httpRequestDurationSeconds.observe(
      { method: 'GET', path: '/test', status: '200', auth_tier: 'public' },
      0.05,
    );
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_http_request_duration_seconds');
    expect(metric).toBeDefined();
  });

  it('httpRequestSizeBytes observes', async () => {
    httpRequestSizeBytes.observe({ method: 'POST', path: '/test' }, 1024);
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_http_request_size_bytes');
    expect(metric).toBeDefined();
  });

  it('httpResponseSizeBytes observes', async () => {
    httpResponseSizeBytes.observe({ method: 'GET', path: '/test', status: '200' }, 2048);
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_http_response_size_bytes');
    expect(metric).toBeDefined();
  });
});

describe('auth metrics', () => {
  it('authAttemptsTotal increments', async () => {
    authAttemptsTotal.inc({ method: 'api_key', result: 'success' });
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_auth_attempts_total');
    expect(metric).toBeDefined();
  });
});

describe('rate limit metrics', () => {
  it('rateLimitDenialsTotal increments', async () => {
    rateLimitDenialsTotal.inc({ tier: 'free', reason: 'bucket' });
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_ratelimit_denials_total');
    expect(metric).toBeDefined();
  });

  it('quotaUsageRatio sets gauge', async () => {
    quotaUsageRatio.set({ firm_id: 'f1', tier: 'free' }, 0.75);
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_quota_usage_ratio');
    expect(metric).toBeDefined();
  });
});

describe('KYC metrics', () => {
  it('kycSessionsCreatedTotal increments', async () => {
    kycSessionsCreatedTotal.inc({ workflow_type: 'kyc', mode: 'live' });
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_kyc_sessions_created_total');
    expect(metric).toBeDefined();
  });

  it('kycSessionOutcomesTotal increments', async () => {
    kycSessionOutcomesTotal.inc({ workflow_type: 'kyc', outcome: 'approved' });
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_kyc_session_outcomes_total');
    expect(metric).toBeDefined();
  });
});

describe('Chain metrics', () => {
  it('chainSubmitDurationSeconds observes', async () => {
    chainSubmitDurationSeconds.observe({ operation: 'create' }, 1.5);
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_chain_submit_duration_seconds');
    expect(metric).toBeDefined();
  });

  it('chainSubmitErrorsTotal increments', async () => {
    chainSubmitErrorsTotal.inc({ operation: 'create', error_code: 'submit_failed' });
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_chain_submit_errors_total');
    expect(metric).toBeDefined();
  });
});

describe('webhook metrics', () => {
  it('webhookDeliveriesTotal increments', async () => {
    webhookDeliveriesTotal.inc({ result: 'success' });
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_webhook_deliveries_total');
    expect(metric).toBeDefined();
  });

  it('webhookDeliveryDurationSeconds observes', async () => {
    webhookDeliveryDurationSeconds.observe({ result: 'success' }, 0.3);
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_webhook_delivery_duration_seconds');
    expect(metric).toBeDefined();
  });

  it('webhookCircuitBreakersOpen sets gauge', async () => {
    webhookCircuitBreakersOpen.set(2);
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_webhook_circuit_breakers_open');
    expect(metric).toBeDefined();
  });
});

describe('audit metrics', () => {
  it('auditEventsTotal increments', async () => {
    auditEventsTotal.inc({ action_domain: 'firm' });
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_audit_events_total');
    expect(metric).toBeDefined();
  });
});

describe('DB metrics', () => {
  it('dbQueryDurationSeconds observes', async () => {
    dbQueryDurationSeconds.observe({ operation: 'select' }, 0.01);
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_db_query_duration_seconds');
    expect(metric).toBeDefined();
  });
});

describe('metrics text output', () => {
  it('produces valid Prometheus exposition format', async () => {
    httpRequestsTotal.inc({ method: 'GET', path: '/health', status: '200', auth_tier: 'public' });
    const text = await getRegistry().metrics();
    expect(text).toContain('crivacy_http_requests_total');
    expect(text).toContain('method="GET"');
  });
});

describe('resetMetricsForTests', () => {
  it('clears all metrics', async () => {
    httpRequestsTotal.inc({ method: 'GET', path: '/test', status: '200', auth_tier: 'public' });
    resetMetricsForTests();
    // After reset, counter should be 0
    const metrics = await getRegistry().getMetricsAsJSON();
    const metric = metrics.find((m) => m.name === 'crivacy_http_requests_total');
    if (metric !== undefined && 'values' in metric) {
      const values = metric.values as Array<{ value: number }>;
      for (const v of values) {
        expect(v.value).toBe(0);
      }
    }
  });
});
