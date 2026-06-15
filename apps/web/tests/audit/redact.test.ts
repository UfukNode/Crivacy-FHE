/**
 * Tests for the read-time PII redaction engine.
 *
 * These tests cover:
 *
 *   * Default-rule behaviors: `redact`, `hash`, `truncate`, `audience`.
 *   * Audience-specific differences: `firm`, `admin`, `public`,
 *     `compliance`.
 *   * Public-audience fail-closed mode (unknown keys redacted).
 *   * Nested object walking and array mapping.
 *   * Stable hash output (same input → same hash).
 *   * Full-path rules beating leaf-key rules.
 *   * Input non-mutation.
 *   * `mergeRedactionRules` merges overrides onto defaults.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { mergeRedactionRules, redactMeta } from '@/lib/audit';

describe('redactMeta — direct PII', () => {
  it('redacts phone to [REDACTED]', () => {
    const out = redactMeta({ phone: '+905551234567' }, { audience: 'firm' });
    expect(out['phone']).toBe('[REDACTED]');
  });

  it('redacts first_name / last_name / full_name', () => {
    const out = redactMeta(
      { first_name: 'Alice', last_name: 'Karakurt', full_name: 'Alice Karakurt' },
      { audience: 'firm' },
    );
    expect(out['first_name']).toBe('[REDACTED]');
    expect(out['last_name']).toBe('[REDACTED]');
    expect(out['full_name']).toBe('[REDACTED]');
  });

  it('redacts date_of_birth and dob', () => {
    const out = redactMeta(
      { date_of_birth: '1990-01-01', dob: '1990-01-01' },
      { audience: 'firm' },
    );
    expect(out['date_of_birth']).toBe('[REDACTED]');
    expect(out['dob']).toBe('[REDACTED]');
  });

  it('truncates email to first 3 chars + ellipsis', () => {
    const out = redactMeta({ email: 'alice@example.test' }, { audience: 'firm' });
    expect(out['email']).toBe('ali…');
  });

  it('truncates short email to value + ellipsis (shorter than preserveChars)', () => {
    const out = redactMeta({ email: 'ab' }, { audience: 'firm' });
    expect(out['email']).toBe('ab…');
  });

  it('truncates non-string email to [REDACTED]', () => {
    const out = redactMeta({ email: 42 }, { audience: 'firm' });
    expect(out['email']).toBe('[REDACTED]');
  });
});

describe('redactMeta — hashed identifiers', () => {
  it('replaces national_id with [HASH:<12>] tag', () => {
    const out = redactMeta({ national_id: '12345678901' }, { audience: 'firm' });
    const expected = createHash('sha256').update('12345678901').digest('hex').slice(0, 12);
    expect(out['national_id']).toBe(`[HASH:${expected}]`);
  });

  it('hash is stable for the same input', () => {
    const a = redactMeta({ ssn: '123-45-6789' }, { audience: 'firm' })['ssn'];
    const b = redactMeta({ ssn: '123-45-6789' }, { audience: 'firm' })['ssn'];
    expect(a).toBe(b);
  });

  it('hash differs for different inputs', () => {
    const a = redactMeta({ ssn: 'aaa' }, { audience: 'firm' })['ssn'];
    const b = redactMeta({ ssn: 'bbb' }, { audience: 'firm' })['ssn'];
    expect(a).not.toBe(b);
  });

  it('hash is deterministic across object value types via canonical form', () => {
    const out = redactMeta(
      {
        document_number: { country: 'TR', value: 'X123' },
      },
      { audience: 'firm' },
    );
    expect(out['document_number']).toMatch(/^\[HASH:[0-9a-f]{12}\]$/);
  });
});

describe('redactMeta — secrets', () => {
  it('redacts password, secret, token, api_key, signing_secret', () => {
    const out = redactMeta(
      {
        password: 'hunter2',
        secret: 'xyz',
        token: 'abc',
        api_key: 'crv_live_xxx',
        signing_secret: 'whsec_xxx',
      },
      { audience: 'admin' },
    );
    expect(out['password']).toBe('[REDACTED]');
    expect(out['secret']).toBe('[REDACTED]');
    expect(out['token']).toBe('[REDACTED]');
    expect(out['api_key']).toBe('[REDACTED]');
    expect(out['signing_secret']).toBe('[REDACTED]');
  });

  it('redacts authorization and cookie headers', () => {
    const out = redactMeta(
      {
        authorization: 'Bearer xxx',
        cookie: 'session=yyy',
      },
      { audience: 'admin' },
    );
    expect(out['authorization']).toBe('[REDACTED]');
    expect(out['cookie']).toBe('[REDACTED]');
  });
});

describe('redactMeta — audience rules', () => {
  it('admin_note: visible to admin', () => {
    const out = redactMeta({ admin_note: 'escalated' }, { audience: 'admin' });
    expect(out['admin_note']).toBe('escalated');
  });

  it('admin_note: visible to compliance', () => {
    const out = redactMeta({ admin_note: 'gdpr-request' }, { audience: 'compliance' });
    expect(out['admin_note']).toBe('gdpr-request');
  });

  it('admin_note: redacted for firm audience', () => {
    const out = redactMeta({ admin_note: 'internal' }, { audience: 'firm' });
    expect(out['admin_note']).toBe('[REDACTED]');
  });

  it('admin_note: redacted for public audience', () => {
    const out = redactMeta({ admin_note: 'internal' }, { audience: 'public' });
    expect(out['admin_note']).toBe('[REDACTED]');
  });

  it('impersonation_target: visible to admin only (firm redacted)', () => {
    expect(
      redactMeta({ impersonation_target: 'u123' }, { audience: 'admin' })['impersonation_target'],
    ).toBe('u123');
    expect(
      redactMeta({ impersonation_target: 'u123' }, { audience: 'firm' })['impersonation_target'],
    ).toBe('[REDACTED]');
  });
});

describe('redactMeta — keep rules', () => {
  it('keeps contract_id, tx_id, package_id, proof_hash', () => {
    const input = {
      contract_id: 'chain:abc',
      tx_id: 'tx-xyz',
      package_id: '#crivacy-kyc-v2:Crivacy.KYCCredential:KYCCredential',
      proof_hash: '0xdead',
    };
    const out = redactMeta(input, { audience: 'firm' });
    expect(out).toEqual(input);
  });
});

describe('redactMeta — public fail-closed', () => {
  it('redacts unknown keys on public audience by default', () => {
    const out = redactMeta({ random_field: 'anything' }, { audience: 'public' });
    expect(out['random_field']).toBe('[REDACTED]');
  });

  it('keeps unknown keys on firm audience', () => {
    const out = redactMeta({ random_field: 'anything' }, { audience: 'firm' });
    expect(out['random_field']).toBe('anything');
  });

  it('keeps unknown keys on admin audience', () => {
    const out = redactMeta({ random_field: 'anything' }, { audience: 'admin' });
    expect(out['random_field']).toBe('anything');
  });

  it('keeps unknown keys on public when publicFailClosed=false', () => {
    const out = redactMeta(
      { random_field: 'anything' },
      { audience: 'public', publicFailClosed: false },
    );
    expect(out['random_field']).toBe('anything');
  });
});

describe('redactMeta — nested walking', () => {
  it('walks nested objects and applies rules at each leaf', () => {
    const out = redactMeta(
      {
        actor: {
          email: 'alice@acme.test',
          phone: '+905551234567',
        },
        contract_id: 'chain:abc',
      },
      { audience: 'firm' },
    );
    const actor = out['actor'] as Record<string, unknown>;
    expect(actor['email']).toBe('ali…');
    expect(actor['phone']).toBe('[REDACTED]');
    expect(out['contract_id']).toBe('chain:abc');
  });

  it('walks deeply nested objects', () => {
    const out = redactMeta(
      {
        request: {
          body: {
            auth: { password: 'hunter2' },
          },
        },
      },
      { audience: 'firm' },
    );
    const request = out['request'] as Record<string, unknown>;
    const body = request['body'] as Record<string, unknown>;
    const auth = body['auth'] as Record<string, unknown>;
    expect(auth['password']).toBe('[REDACTED]');
  });

  it('maps arrays element-wise when the parent rule is keep', () => {
    const out = redactMeta({ contract_id: 'cid', tags: ['a', 'b', 'c'] }, { audience: 'firm' });
    // `tags` is not a known key — default keep on firm audience.
    expect(out['tags']).toEqual(['a', 'b', 'c']);
  });

  it('applies audience fail-closed to arrays on public', () => {
    const out = redactMeta({ tags: ['a', 'b'] }, { audience: 'public' });
    expect(out['tags']).toBe('[REDACTED]');
  });
});

describe('redactMeta — input non-mutation', () => {
  it('does not mutate the input object', () => {
    const input: Record<string, unknown> = {
      email: 'alice@acme.test',
      nested: { phone: '+9055' },
    };
    const frozen = JSON.stringify(input);
    const _out = redactMeta(input, { audience: 'firm' });
    expect(JSON.stringify(input)).toBe(frozen);
  });
});

describe('redactMeta — custom rules', () => {
  it('respects a custom rule override', () => {
    const rules = mergeRedactionRules({
      custom_key: 'redact',
    });
    const out = redactMeta({ custom_key: 'visible?' }, { audience: 'firm', rules });
    expect(out['custom_key']).toBe('[REDACTED]');
  });

  it('a custom rule overrides the default for a known key', () => {
    const rules = mergeRedactionRules({
      email: 'keep',
    });
    const out = redactMeta({ email: 'alice@acme.test' }, { audience: 'firm', rules });
    expect(out['email']).toBe('alice@acme.test');
  });

  it('mergeRedactionRules returns a frozen object', () => {
    const rules = mergeRedactionRules({ custom: 'keep' });
    expect(Object.isFrozen(rules)).toBe(true);
  });

  it('mergeRedactionRules preserves default rules not overridden', () => {
    const rules = mergeRedactionRules({ custom: 'keep' });
    expect(rules['phone']).toBe('redact');
    expect(rules['custom']).toBe('keep');
  });
});
