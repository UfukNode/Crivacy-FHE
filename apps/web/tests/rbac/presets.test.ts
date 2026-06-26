/**
 * Preset role catalogue integrity tests.
 *
 * Locks in the shape of the 7 preset roles so an accidental edit to
 * `lib/rbac/roles.ts` or `lib/rbac/permissions.ts` shows up as a
 * test failure instead of a silent change in who can do what. The
 * matrix approved in the Faz 0 plan is the source of truth — any
 * adjustment requires updating both this test and the plan doc.
 *
 * Approach: assert role metadata, a floor of permissions that MUST
 * be present for each preset, and a ceiling of permissions that MUST
 * NOT be present. Total counts are checked loosely (>= expected) so
 * adding a new permission to a role doesn't require touching this
 * file — only removing or moving one does.
 */

import { describe, expect, it } from 'vitest';

import { ALL_PERMISSION_CODES, SYSTEM_PERMISSIONS } from '@/lib/rbac/permissions';
import { PRESET_ROLES, getPresetRole } from '@/lib/rbac/roles';

describe('SYSTEM_PERMISSIONS catalogue', () => {
  it('exports at least the minimum number of permission codes the matrix requires', () => {
    // Floor derived from the Faz 0 matrix — concrete numbers matter
    // less than "this stays in the ~60-80 range". A drop below 60
    // usually means a domain was accidentally removed; a jump above
    // 120 usually means scope creep that should go through matrix
    // review.
    expect(SYSTEM_PERMISSIONS.length).toBeGreaterThanOrEqual(60);
    expect(SYSTEM_PERMISSIONS.length).toBeLessThan(120);
  });

  it('emits unique permission codes — no duplicates', () => {
    const codes = SYSTEM_PERMISSIONS.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('exports ALL_PERMISSION_CODES as the full code set', () => {
    expect(ALL_PERMISSION_CODES.size).toBe(SYSTEM_PERMISSIONS.length);
    for (const p of SYSTEM_PERMISSIONS) {
      expect(ALL_PERMISSION_CODES.has(p.code)).toBe(true);
    }
  });

  it('every permission belongs to a known domain', () => {
    const validDomains = new Set([
      'auth',
      'kyc',
      'credential',
      'ticket',
      'webhook',
      'firm',
      'admin',
      'system',
      'api_key',
      'oauth_client',
      'audit',
      'playground',
      'profile',
      'usage',
      'notifications',
    ]);
    for (const p of SYSTEM_PERMISSIONS) {
      expect(validDomains.has(p.domain)).toBe(true);
    }
  });
});

describe('PRESET_ROLES catalogue', () => {
  it('exports exactly 7 presets (4 firm_user + 3 admin_user)', () => {
    expect(PRESET_ROLES).toHaveLength(7);

    const firmRoles = PRESET_ROLES.filter((r) => r.userType === 'firm_user');
    const adminRoles = PRESET_ROLES.filter((r) => r.userType === 'admin_user');
    expect(firmRoles).toHaveLength(4);
    expect(adminRoles).toHaveLength(3);
  });

  it('marks only Owner and Superadmin as system roles', () => {
    const systemRoles = PRESET_ROLES.filter((r) => r.isSystem);
    expect(systemRoles.map((r) => r.name).sort()).toEqual(['owner', 'superadmin']);
  });

  it('every preset permission code exists in the catalogue', () => {
    // Catch typos where a preset claims a code that was never
    // defined — the seed script would silently skip it, leaving
    // users under-permissioned in production.
    for (const role of PRESET_ROLES) {
      for (const code of role.permissions) {
        expect(
          ALL_PERMISSION_CODES.has(code),
          `Preset "${role.name}" (${role.userType}) references undefined permission "${code}"`,
        ).toBe(true);
      }
    }
  });

  it('every preset has a non-empty permission set', () => {
    for (const role of PRESET_ROLES) {
      expect(role.permissions.length).toBeGreaterThan(0);
    }
  });
});

describe('firm_user preset matrix', () => {
  function firmRole(name: 'viewer' | 'member' | 'admin' | 'owner'): Set<string> {
    const role = getPresetRole(name, 'firm_user');
    expect(role).toBeDefined();
    return new Set(role!.permissions);
  }

  it('Viewer has read access but no mutations or playground', () => {
    const perms = firmRole('viewer');
    // Must include — read-only floor
    expect(perms.has('firm.read')).toBe(true);
    expect(perms.has('webhook.read')).toBe(true);
    expect(perms.has('api_key.read')).toBe(true);
    expect(perms.has('usage.read')).toBe(true);
    // Must NOT include — mutation / playground ceiling
    expect(perms.has('api_key.create')).toBe(false);
    expect(perms.has('webhook.create')).toBe(false);
    expect(perms.has('webhook.delete')).toBe(false);
    expect(perms.has('playground.execute')).toBe(false);
    expect(perms.has('audit.read.firm')).toBe(false);
    expect(perms.has('firm.update')).toBe(false);
  });

  it('Member extends Viewer with own-resource mutations and playground', () => {
    const viewerPerms = firmRole('viewer');
    const memberPerms = firmRole('member');

    // Member is a superset of Viewer
    for (const code of viewerPerms) {
      expect(memberPerms.has(code)).toBe(true);
    }

    // Member-specific additions
    expect(memberPerms.has('api_key.create')).toBe(true);
    expect(memberPerms.has('api_key.rotate.own')).toBe(true);
    expect(memberPerms.has('api_key.revoke.own')).toBe(true);
    expect(memberPerms.has('webhook.create')).toBe(true);
    expect(memberPerms.has('webhook.update')).toBe(true);
    expect(memberPerms.has('playground.execute')).toBe(true);

    // Still denied — member ceiling
    expect(memberPerms.has('webhook.delete')).toBe(false);
    expect(memberPerms.has('api_key.revoke.any')).toBe(false);
    expect(memberPerms.has('firm.update')).toBe(false);
    expect(memberPerms.has('audit.read.firm')).toBe(false);
  });

  it('Admin extends Member with firm settings, team mgmt, and any-resource mutations', () => {
    const memberPerms = firmRole('member');
    const adminPerms = firmRole('admin');

    // Superset of Member
    for (const code of memberPerms) {
      expect(adminPerms.has(code)).toBe(true);
    }

    // Admin-specific additions
    expect(adminPerms.has('firm.update')).toBe(true);
    expect(adminPerms.has('firm.user.invite')).toBe(true);
    expect(adminPerms.has('firm.user.role_change')).toBe(true);
    expect(adminPerms.has('firm.user.remove')).toBe(true);
    expect(adminPerms.has('api_key.rotate.any')).toBe(true);
    expect(adminPerms.has('api_key.revoke.any')).toBe(true);
    expect(adminPerms.has('webhook.delete')).toBe(true);
    expect(adminPerms.has('oauth_client.create')).toBe(true);
    expect(adminPerms.has('audit.read.firm')).toBe(true);

    // Owner-only ceiling
    expect(adminPerms.has('firm.delete')).toBe(false);
    expect(adminPerms.has('firm.transfer_ownership')).toBe(false);
  });

  it('Owner extends Admin with irreversible firm-level operations', () => {
    const adminPerms = firmRole('admin');
    const ownerPerms = firmRole('owner');

    // Superset of Admin
    for (const code of adminPerms) {
      expect(ownerPerms.has(code)).toBe(true);
    }

    // Owner-specific additions
    expect(ownerPerms.has('firm.delete')).toBe(true);
    expect(ownerPerms.has('firm.transfer_ownership')).toBe(true);
  });
});

describe('admin_user preset matrix', () => {
  function adminRole(name: 'support' | 'admin' | 'superadmin'): Set<string> {
    const role = getPresetRole(name, 'admin_user');
    expect(role).toBeDefined();
    return new Set(role!.permissions);
  }

  it('Support reads firms + customers + tickets; no mutations on firms/customers', () => {
    const perms = adminRole('support');
    // Read access
    expect(perms.has('admin.firm.read')).toBe(true);
    expect(perms.has('admin.customer.read')).toBe(true);
    expect(perms.has('admin.ticket.read_all')).toBe(true);
    expect(perms.has('admin.audit.read')).toBe(true);
    expect(perms.has('admin.blacklist.read')).toBe(true);
    // Ticket-level actions Support drives
    expect(perms.has('admin.ticket.take_over')).toBe(true);
    expect(perms.has('admin.ticket.assign')).toBe(true);
    expect(perms.has('admin.ticket.add_internal_note')).toBe(true);
    // Ceiling — no mutations on firms or customers
    expect(perms.has('admin.firm.create')).toBe(false);
    expect(perms.has('admin.firm.update')).toBe(false);
    expect(perms.has('admin.customer.ban')).toBe(false);
    expect(perms.has('admin.customer.unban')).toBe(false);
    expect(perms.has('admin.rbac.role_manage')).toBe(false);
    expect(perms.has('admin.user.create')).toBe(false);
  });

  it('Admin extends Support with firm/customer mutations and status page', () => {
    const supportPerms = adminRole('support');
    const adminPerms = adminRole('admin');

    for (const code of supportPerms) {
      expect(adminPerms.has(code)).toBe(true);
    }

    // Admin-specific additions
    expect(adminPerms.has('admin.firm.create')).toBe(true);
    expect(adminPerms.has('admin.firm.update')).toBe(true);
    expect(adminPerms.has('admin.firm.suspend')).toBe(true);
    expect(adminPerms.has('admin.customer.ban')).toBe(true);
    expect(adminPerms.has('admin.blacklist.manage')).toBe(true);
    expect(adminPerms.has('admin.status.component_manage')).toBe(true);
    expect(adminPerms.has('admin.status.incident_manage')).toBe(true);
    expect(adminPerms.has('admin.system.metrics_read')).toBe(true);
    expect(adminPerms.has('admin.rbac.user_role_assign')).toBe(true);

    // Superadmin-only ceiling
    expect(adminPerms.has('admin.firm.restore')).toBe(false);
    expect(adminPerms.has('admin.customer.unban')).toBe(false);
    expect(adminPerms.has('admin.rbac.role_manage')).toBe(false);
    expect(adminPerms.has('admin.rbac.permission_manage')).toBe(false);
    expect(adminPerms.has('admin.user.create')).toBe(false);
    expect(adminPerms.has('admin.user.delete')).toBe(false);
  });

  it('Superadmin extends Admin with irreversible ops + RBAC meta + admin user lifecycle', () => {
    const adminPerms = adminRole('admin');
    const superPerms = adminRole('superadmin');

    for (const code of adminPerms) {
      expect(superPerms.has(code)).toBe(true);
    }

    // Superadmin-specific additions
    expect(superPerms.has('admin.firm.restore')).toBe(true);
    expect(superPerms.has('admin.customer.unban')).toBe(true);
    expect(superPerms.has('admin.rbac.role_manage')).toBe(true);
    expect(superPerms.has('admin.rbac.permission_manage')).toBe(true);
    expect(superPerms.has('admin.user.create')).toBe(true);
    expect(superPerms.has('admin.user.update')).toBe(true);
    expect(superPerms.has('admin.user.delete')).toBe(true);
    expect(superPerms.has('admin.user.totp_reset')).toBe(true);
  });
});

describe('hierarchy ↔ preset name mapping', () => {
  it('every firm_users.role hierarchy enum value maps to a firm_user preset', () => {
    const hierarchy = ['owner', 'admin', 'member', 'viewer'] as const;
    for (const role of hierarchy) {
      expect(getPresetRole(role, 'firm_user')).toBeDefined();
    }
  });

  it('every admin_users.role hierarchy enum value maps to an admin_user preset', () => {
    const hierarchy = ['superadmin', 'admin', 'support'] as const;
    for (const role of hierarchy) {
      expect(getPresetRole(role, 'admin_user')).toBeDefined();
    }
  });
});
