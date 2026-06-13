/**
 * IPv6 `/64` bucket-collapse tests for the auth rate limiter.
 *
 * A single attacker typically holds an entire IPv6 `/64` subnet (the
 * standard residential + VPS allocation). Without collapse they could
 * rotate the low 64 bits freely and land in a different rate-limit
 * bucket on every request. These cases pin the contract that every
 * address inside the same `/64` normalizes to the same key.
 */

import { describe, expect, it } from 'vitest';

import { normalizeIpForBucket } from '@/lib/auth-rate-limit/enforce';

describe('normalizeIpForBucket — IPv4 pass-through', () => {
  it('returns IPv4 addresses unchanged', () => {
    expect(normalizeIpForBucket('1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIpForBucket('192.168.0.1')).toBe('192.168.0.1');
  });

  it('returns non-IP strings unchanged', () => {
    expect(normalizeIpForBucket('not-an-ip')).toBe('not-an-ip');
    expect(normalizeIpForBucket('')).toBe('');
  });
});

describe('normalizeIpForBucket — IPv6 /64 collapse', () => {
  it('collapses addresses in the same /64 to the same bucket', () => {
    const a = normalizeIpForBucket('2001:db8:1234:5678::1');
    const b = normalizeIpForBucket('2001:db8:1234:5678::dead:beef');
    const c = normalizeIpForBucket('2001:db8:1234:5678:ffff:ffff:ffff:ffff');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe('2001:0db8:1234:5678::/64');
  });

  it('keeps addresses in different /64 subnets in different buckets', () => {
    const a = normalizeIpForBucket('2001:db8:1234:5678::1');
    const b = normalizeIpForBucket('2001:db8:1234:5679::1');
    expect(a).not.toBe(b);
  });

  it('handles fully expanded IPv6 without `::` compression', () => {
    const full = '2001:0db8:1234:5678:0000:0000:0000:0001';
    const compressed = '2001:db8:1234:5678::1';
    expect(normalizeIpForBucket(full)).toBe(normalizeIpForBucket(compressed));
  });

  it('pads short hex groups correctly', () => {
    expect(normalizeIpForBucket('2001:db8:1:2::1')).toBe('2001:0db8:0001:0002::/64');
  });

  it('lower-cases hex digits for deterministic bucket keys', () => {
    const lower = normalizeIpForBucket('2001:DB8:ABCD:EF01::1');
    expect(lower).toBe('2001:0db8:abcd:ef01::/64');
  });

  it('strips zone identifiers before collapsing', () => {
    const zoned = normalizeIpForBucket('fe80::1%eth0');
    const plain = normalizeIpForBucket('fe80::1');
    expect(zoned).toBe(plain);
  });

  it('handles IPv4-mapped IPv6 without crashing', () => {
    const out = normalizeIpForBucket('::ffff:1.2.3.4');
    expect(out).toBe('0000:0000:0000:0000::/64');
  });

  it('handles loopback ::1 without crashing', () => {
    expect(normalizeIpForBucket('::1')).toBe('0000:0000:0000:0000::/64');
  });

  it('returns the input unchanged on malformed IPv6', () => {
    expect(normalizeIpForBucket(':::::')).toBe(':::::');
    expect(normalizeIpForBucket('2001:db8::bad::1')).toBe('2001:db8::bad::1');
  });
});
