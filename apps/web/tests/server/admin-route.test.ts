/**
 * Admin route middleware tests — token extraction, CIDR matching,
 * role hierarchy, and IP allowlist.
 */

import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import {
  checkIpAllowlist,
  extractAdminToken,
  meetsAdminRoleRequirement,
} from '@/server/middleware/admin-route';

/* ------------------------------------------------------------------ */
/* extractAdminToken                                                   */
/* ------------------------------------------------------------------ */

describe('extractAdminToken', () => {
  it('extracts token from Authorization header', () => {
    const req = new NextRequest(
      new Request('https://admin.crivacy.test/api/internal/admin', {
        headers: { authorization: 'Bearer my-jwt-token' },
      }),
    );
    expect(extractAdminToken(req)).toBe('my-jwt-token');
  });

  it('returns null when no Authorization header or cookie', () => {
    const req = new NextRequest(new Request('https://admin.crivacy.test/api/internal/admin'));
    expect(extractAdminToken(req)).toBeNull();
  });

  it('returns null for empty Bearer value', () => {
    const req = new NextRequest(
      new Request('https://admin.crivacy.test/api/internal/admin', {
        headers: { authorization: 'Bearer ' },
      }),
    );
    expect(extractAdminToken(req)).toBeNull();
  });

  it('ignores non-Bearer auth schemes', () => {
    const req = new NextRequest(
      new Request('https://admin.crivacy.test/api/internal/admin', {
        headers: { authorization: 'Basic abc123' },
      }),
    );
    expect(extractAdminToken(req)).toBeNull();
  });

  it('extracts token from __crivacy_admin_at cookie', () => {
    const req = new NextRequest(
      new Request('https://admin.crivacy.test/api/internal/admin', {
        headers: { cookie: '__crivacy_admin_at=cookie-jwt-token' },
      }),
    );
    expect(extractAdminToken(req)).toBe('cookie-jwt-token');
  });

  it('prefers Authorization header over cookie', () => {
    const req = new NextRequest(
      new Request('https://admin.crivacy.test/api/internal/admin', {
        headers: {
          authorization: 'Bearer header-token',
          cookie: '__crivacy_admin_at=cookie-token',
        },
      }),
    );
    expect(extractAdminToken(req)).toBe('header-token');
  });
});

/* ------------------------------------------------------------------ */
/* meetsAdminRoleRequirement                                           */
/* ------------------------------------------------------------------ */

describe('meetsAdminRoleRequirement', () => {
  it('superadmin meets all roles', () => {
    expect(meetsAdminRoleRequirement('superadmin', 'support')).toBe(true);
    expect(meetsAdminRoleRequirement('superadmin', 'admin')).toBe(true);
    expect(meetsAdminRoleRequirement('superadmin', 'superadmin')).toBe(true);
  });

  it('admin meets admin and support, not superadmin', () => {
    expect(meetsAdminRoleRequirement('admin', 'support')).toBe(true);
    expect(meetsAdminRoleRequirement('admin', 'admin')).toBe(true);
    expect(meetsAdminRoleRequirement('admin', 'superadmin')).toBe(false);
  });

  it('support meets only support', () => {
    expect(meetsAdminRoleRequirement('support', 'support')).toBe(true);
    expect(meetsAdminRoleRequirement('support', 'admin')).toBe(false);
    expect(meetsAdminRoleRequirement('support', 'superadmin')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* checkIpAllowlist                                                    */
/* ------------------------------------------------------------------ */

describe('checkIpAllowlist', () => {
  it('returns true when allowlist is empty (any IP allowed)', () => {
    expect(checkIpAllowlist('10.0.0.1', [])).toBe(true);
    expect(checkIpAllowlist(null, [])).toBe(true);
  });

  it('returns false when ip is null and allowlist is non-empty', () => {
    expect(checkIpAllowlist(null, ['10.0.0.0/8'])).toBe(false);
  });

  it('matches exact IP', () => {
    expect(checkIpAllowlist('192.168.1.100', ['192.168.1.100'])).toBe(true);
    expect(checkIpAllowlist('192.168.1.101', ['192.168.1.100'])).toBe(false);
  });

  it('matches CIDR /24 subnet', () => {
    expect(checkIpAllowlist('10.0.1.50', ['10.0.1.0/24'])).toBe(true);
    expect(checkIpAllowlist('10.0.1.255', ['10.0.1.0/24'])).toBe(true);
    expect(checkIpAllowlist('10.0.2.1', ['10.0.1.0/24'])).toBe(false);
  });

  it('matches CIDR /16 subnet', () => {
    expect(checkIpAllowlist('172.16.50.1', ['172.16.0.0/16'])).toBe(true);
    expect(checkIpAllowlist('172.17.0.1', ['172.16.0.0/16'])).toBe(false);
  });

  it('matches CIDR /32 (exact)', () => {
    expect(checkIpAllowlist('10.0.0.1', ['10.0.0.1/32'])).toBe(true);
    expect(checkIpAllowlist('10.0.0.2', ['10.0.0.1/32'])).toBe(false);
  });

  it('matches CIDR /0 (any)', () => {
    expect(checkIpAllowlist('1.2.3.4', ['0.0.0.0/0'])).toBe(true);
    expect(checkIpAllowlist('255.255.255.255', ['0.0.0.0/0'])).toBe(true);
  });

  it('matches against multiple entries', () => {
    const allowlist = ['10.0.0.0/8', '192.168.0.100'];
    expect(checkIpAllowlist('10.5.5.5', allowlist)).toBe(true);
    expect(checkIpAllowlist('192.168.0.100', allowlist)).toBe(true);
    expect(checkIpAllowlist('192.168.0.101', allowlist)).toBe(false);
  });

  it('rejects invalid CIDR notation gracefully', () => {
    expect(checkIpAllowlist('10.0.0.1', ['not-an-ip/24'])).toBe(false);
    expect(checkIpAllowlist('10.0.0.1', ['10.0.0.0/abc'])).toBe(false);
  });
});
