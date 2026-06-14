/**
 * Tests for `DiditConfig` loading + caching.
 *
 * Every helper in `@crivacy-fhe/adapter-didit` accepts a `DiditConfig` injected by
 * the caller. `loadDiditConfig` is the only place that reads env
 * variables, so the tests here cover:
 *
 *   * All defaults applied when the only required env vars are set.
 *   * Required-env errors: each of the five mandatory keys surfaces
 *     `invalid_config` when missing or empty.
 *   * Shape validation: bad URL / bad workflow id / bad api key /
 *     bad webhook secret / out-of-range ints / drift ceiling.
 *   * Trailing-slash stripping on base URL and callback URL.
 *   * Boolean parsing for the two behavior flags.
 *   * Cache reset.
 */

import { describe, expect, it } from 'vitest';

import { DiditError, getDiditConfig, loadDiditConfig, resetDiditConfigForTests } from '@crivacy-fhe/adapter-didit';
import type { DiditEnv } from '@crivacy-fhe/adapter-didit';

import {
  FIXTURE_ADDRESS_WORKFLOW_ID,
  FIXTURE_API_KEY,
  FIXTURE_CALLBACK_URL,
  FIXTURE_KYC_WORKFLOW_ID,
  FIXTURE_WEBHOOK_SECRET,
} from './fixtures';

function baseEnv(overrides: Partial<DiditEnv> = {}): DiditEnv {
  return {
    DIDIT_API_KEY: FIXTURE_API_KEY,
    DIDIT_KYC_WORKFLOW_ID: FIXTURE_KYC_WORKFLOW_ID,
    DIDIT_ADDRESS_WORKFLOW_ID: FIXTURE_ADDRESS_WORKFLOW_ID,
    DIDIT_WEBHOOK_SECRET: FIXTURE_WEBHOOK_SECRET,
    DIDIT_DEFAULT_CALLBACK_URL: FIXTURE_CALLBACK_URL,
    ...overrides,
  };
}

describe('loadDiditConfig — defaults + happy path', () => {
  it('applies defaults when only required keys are set', () => {
    const cfg = loadDiditConfig(baseEnv());
    expect(cfg.baseUrl).toBe('https://verification.didit.me');
    expect(cfg.apiKey).toBe(FIXTURE_API_KEY);
    expect(cfg.requestTimeoutMs).toBe(10_000);
    expect(cfg.maxRetries).toBe(2);
    expect(cfg.retryBaseDelayMs).toBe(250);
    expect(cfg.webhookDriftSeconds).toBe(300);
    expect(cfg.failClosedOnUnknownWorkflow).toBe(true);
    expect(cfg.proofHashStrict).toBe(true);
    expect(cfg.kycWorkflowId).toBe(FIXTURE_KYC_WORKFLOW_ID);
    expect(cfg.addressWorkflowId).toBe(FIXTURE_ADDRESS_WORKFLOW_ID);
    expect(cfg.defaultCallbackUrl).toBe(FIXTURE_CALLBACK_URL);
    expect(cfg.webhookSecret).toBe(FIXTURE_WEBHOOK_SECRET);
  });

  it('freezes the returned config so it cannot be mutated', () => {
    const cfg = loadDiditConfig(baseEnv());
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('strips a trailing slash from DIDIT_BASE_URL', () => {
    const cfg = loadDiditConfig(baseEnv({ DIDIT_BASE_URL: 'https://didit.test/' }));
    expect(cfg.baseUrl).toBe('https://didit.test');
  });

  it('strips multiple trailing slashes from DIDIT_BASE_URL', () => {
    const cfg = loadDiditConfig(baseEnv({ DIDIT_BASE_URL: 'https://didit.test///' }));
    expect(cfg.baseUrl).toBe('https://didit.test');
  });

  it('accepts http base URLs (for loopback test fixtures)', () => {
    const cfg = loadDiditConfig(baseEnv({ DIDIT_BASE_URL: 'http://127.0.0.1:9999' }));
    expect(cfg.baseUrl).toBe('http://127.0.0.1:9999');
  });

  it('parses integer tunables from string env values', () => {
    const cfg = loadDiditConfig(
      baseEnv({
        DIDIT_REQUEST_TIMEOUT_MS: '5000',
        DIDIT_MAX_RETRIES: '3',
        DIDIT_RETRY_BASE_DELAY_MS: '100',
        DIDIT_WEBHOOK_DRIFT_SECONDS: '600',
      }),
    );
    expect(cfg.requestTimeoutMs).toBe(5000);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.retryBaseDelayMs).toBe(100);
    expect(cfg.webhookDriftSeconds).toBe(600);
  });
});

describe('loadDiditConfig — required env', () => {
  const requiredKeys = [
    'DIDIT_API_KEY',
    'DIDIT_KYC_WORKFLOW_ID',
    'DIDIT_ADDRESS_WORKFLOW_ID',
    'DIDIT_WEBHOOK_SECRET',
    'DIDIT_DEFAULT_CALLBACK_URL',
  ] as const;

  for (const key of requiredKeys) {
    it(`throws invalid_config when ${key} is missing`, () => {
      const env = baseEnv();
      delete env[key];
      try {
        loadDiditConfig(env);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(DiditError);
        expect((err as DiditError).code).toBe('invalid_config');
        expect((err as DiditError).message).toContain(key);
      }
    });

    it(`throws invalid_config when ${key} is the empty string`, () => {
      const env = baseEnv({ [key]: '' });
      try {
        loadDiditConfig(env);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(DiditError);
        expect((err as DiditError).code).toBe('invalid_config');
      }
    });
  }
});

describe('loadDiditConfig — shape validation', () => {
  it('rejects an api key with whitespace', () => {
    expect(() => loadDiditConfig(baseEnv({ DIDIT_API_KEY: 'bad key' }))).toThrow(DiditError);
  });

  it('rejects an api key shorter than 8 chars', () => {
    expect(() => loadDiditConfig(baseEnv({ DIDIT_API_KEY: 'short' }))).toThrow(DiditError);
  });

  it('rejects a webhook secret with whitespace', () => {
    expect(() => loadDiditConfig(baseEnv({ DIDIT_WEBHOOK_SECRET: 'bad secret' }))).toThrow(
      DiditError,
    );
  });

  it('rejects a non-UUID kyc workflow id', () => {
    expect(() => loadDiditConfig(baseEnv({ DIDIT_KYC_WORKFLOW_ID: 'not-a-uuid' }))).toThrow(
      DiditError,
    );
  });

  it('rejects an uppercase UUID (case-sensitive lowercase pin)', () => {
    expect(() =>
      loadDiditConfig(baseEnv({ DIDIT_KYC_WORKFLOW_ID: '164E446D-7414-494E-901D-7EED2D43D86F' })),
    ).toThrow(DiditError);
  });

  it('rejects a non-URL default callback', () => {
    expect(() => loadDiditConfig(baseEnv({ DIDIT_DEFAULT_CALLBACK_URL: 'not a url' }))).toThrow(
      DiditError,
    );
  });

  it('rejects a ftp:// scheme on the callback URL', () => {
    expect(() =>
      loadDiditConfig(baseEnv({ DIDIT_DEFAULT_CALLBACK_URL: 'ftp://didit.test' })),
    ).toThrow(DiditError);
  });

  it('rejects a non-URL base URL', () => {
    expect(() => loadDiditConfig(baseEnv({ DIDIT_BASE_URL: 'not a url' }))).toThrow(DiditError);
  });

  it('rejects requestTimeoutMs above the 120s ceiling', () => {
    expect(() => loadDiditConfig(baseEnv({ DIDIT_REQUEST_TIMEOUT_MS: '120001' }))).toThrow(
      DiditError,
    );
  });

  it('rejects a zero requestTimeoutMs (must be positive)', () => {
    expect(() => loadDiditConfig(baseEnv({ DIDIT_REQUEST_TIMEOUT_MS: '0' }))).toThrow(DiditError);
  });

  it('rejects maxRetries above the ceiling of 5', () => {
    expect(() => loadDiditConfig(baseEnv({ DIDIT_MAX_RETRIES: '6' }))).toThrow(DiditError);
  });

  it('rejects a negative retryBaseDelayMs', () => {
    expect(() => loadDiditConfig(baseEnv({ DIDIT_RETRY_BASE_DELAY_MS: '-1' }))).toThrow(DiditError);
  });

  it('rejects a webhookDriftSeconds above the 1 hour ceiling', () => {
    expect(() => loadDiditConfig(baseEnv({ DIDIT_WEBHOOK_DRIFT_SECONDS: '3601' }))).toThrow(
      DiditError,
    );
  });

  it('rejects a non-integer tunable string', () => {
    expect(() => loadDiditConfig(baseEnv({ DIDIT_REQUEST_TIMEOUT_MS: 'ten-seconds' }))).toThrow(
      DiditError,
    );
  });
});

describe('loadDiditConfig — behavior flags', () => {
  it('enables failClosedOnUnknownWorkflow on the "true" literal', () => {
    const cfg = loadDiditConfig(baseEnv({ DIDIT_FAIL_CLOSED_ON_UNKNOWN_WORKFLOW: 'true' }));
    expect(cfg.failClosedOnUnknownWorkflow).toBe(true);
  });

  it('enables failClosedOnUnknownWorkflow on the "1" literal', () => {
    const cfg = loadDiditConfig(baseEnv({ DIDIT_FAIL_CLOSED_ON_UNKNOWN_WORKFLOW: '1' }));
    expect(cfg.failClosedOnUnknownWorkflow).toBe(true);
  });

  it('disables failClosedOnUnknownWorkflow on the "false" literal', () => {
    const cfg = loadDiditConfig(baseEnv({ DIDIT_FAIL_CLOSED_ON_UNKNOWN_WORKFLOW: 'false' }));
    expect(cfg.failClosedOnUnknownWorkflow).toBe(false);
  });

  it('disables failClosedOnUnknownWorkflow on empty string', () => {
    const cfg = loadDiditConfig(baseEnv({ DIDIT_FAIL_CLOSED_ON_UNKNOWN_WORKFLOW: '' }));
    expect(cfg.failClosedOnUnknownWorkflow).toBe(false);
  });

  it('disables proofHashStrict on "no"', () => {
    const cfg = loadDiditConfig(baseEnv({ DIDIT_PROOF_HASH_STRICT: 'no' }));
    expect(cfg.proofHashStrict).toBe(false);
  });

  it('enables proofHashStrict on "yes"', () => {
    const cfg = loadDiditConfig(baseEnv({ DIDIT_PROOF_HASH_STRICT: 'yes' }));
    expect(cfg.proofHashStrict).toBe(true);
  });
});

describe('getDiditConfig — singleton cache', () => {
  it('caches the first load result', () => {
    process.env['DIDIT_API_KEY'] = FIXTURE_API_KEY;
    process.env['DIDIT_KYC_WORKFLOW_ID'] = FIXTURE_KYC_WORKFLOW_ID;
    process.env['DIDIT_ADDRESS_WORKFLOW_ID'] = FIXTURE_ADDRESS_WORKFLOW_ID;
    process.env['DIDIT_WEBHOOK_SECRET'] = FIXTURE_WEBHOOK_SECRET;
    process.env['DIDIT_DEFAULT_CALLBACK_URL'] = FIXTURE_CALLBACK_URL;
    try {
      resetDiditConfigForTests();
      const first = getDiditConfig();
      const second = getDiditConfig();
      expect(first).toBe(second);
    } finally {
      resetDiditConfigForTests();
      Reflect.deleteProperty(process.env, 'DIDIT_API_KEY');
      Reflect.deleteProperty(process.env, 'DIDIT_KYC_WORKFLOW_ID');
      Reflect.deleteProperty(process.env, 'DIDIT_ADDRESS_WORKFLOW_ID');
      Reflect.deleteProperty(process.env, 'DIDIT_WEBHOOK_SECRET');
      Reflect.deleteProperty(process.env, 'DIDIT_DEFAULT_CALLBACK_URL');
    }
  });

  it('reloads after resetDiditConfigForTests()', () => {
    process.env['DIDIT_API_KEY'] = FIXTURE_API_KEY;
    process.env['DIDIT_KYC_WORKFLOW_ID'] = FIXTURE_KYC_WORKFLOW_ID;
    process.env['DIDIT_ADDRESS_WORKFLOW_ID'] = FIXTURE_ADDRESS_WORKFLOW_ID;
    process.env['DIDIT_WEBHOOK_SECRET'] = FIXTURE_WEBHOOK_SECRET;
    process.env['DIDIT_DEFAULT_CALLBACK_URL'] = FIXTURE_CALLBACK_URL;
    try {
      resetDiditConfigForTests();
      const first = getDiditConfig();
      resetDiditConfigForTests();
      const second = getDiditConfig();
      expect(first).not.toBe(second);
      // But their content must still be equal.
      expect(second.apiKey).toBe(first.apiKey);
    } finally {
      resetDiditConfigForTests();
      Reflect.deleteProperty(process.env, 'DIDIT_API_KEY');
      Reflect.deleteProperty(process.env, 'DIDIT_KYC_WORKFLOW_ID');
      Reflect.deleteProperty(process.env, 'DIDIT_ADDRESS_WORKFLOW_ID');
      Reflect.deleteProperty(process.env, 'DIDIT_WEBHOOK_SECRET');
      Reflect.deleteProperty(process.env, 'DIDIT_DEFAULT_CALLBACK_URL');
    }
  });
});
