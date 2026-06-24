/**
 * Privilege-escalation guard tests (AUDIT C-1 / BUG #58).
 *
 * `assertCanAssignSystemRoles` is the check that the admin RBAC
 * role-assignment route (`PUT /api/internal/admin/rbac/users/:id/roles`)
 * was documented to perform but did not. It must stop a non-Superadmin
 * caller from granting a system role (Superadmin / Owner presets), which
 * would otherwise let any `admin` elevate itself to Superadmin.
 */

import { describe, expect, it } from 'vitest';

import { assertCanAssignSystemRoles } from '@/lib/rbac/assignment';
import { RbacError } from '@/lib/rbac/errors';

const SUPERADMIN = { name: 'superadmin', isSystem: true } as const;
const OWNER = { name: 'owner', isSystem: true } as const;
const ADMIN = { name: 'admin', isSystem: false } as const;
const SUPPORT = { name: 'support', isSystem: false } as const;
const MEMBER = { name: 'member', isSystem: false } as const;

describe('assertCanAssignSystemRoles', () => {
  describe('blocks privilege escalation by non-Superadmins', () => {
    it('throws when an admin tries to assign the Superadmin role', () => {
      expect(() => assertCanAssignSystemRoles('admin', [SUPERADMIN])).toThrow(RbacError);
    });

    it('throws permission_denied (HTTP 403 semantics)', () => {
      try {
        assertCanAssignSystemRoles('admin', [SUPERADMIN]);
        throw new Error('expected guard to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(RbacError);
        expect((err as RbacError).code).toBe('permission_denied');
      }
    });

    it('throws when an admin assigns Superadmin mixed with allowed roles', () => {
      expect(() =>
        assertCanAssignSystemRoles('admin', [ADMIN, SUPERADMIN, SUPPORT]),
      ).toThrow(RbacError);
    });

    it('throws when an admin assigns the Owner system role', () => {
      expect(() => assertCanAssignSystemRoles('admin', [OWNER])).toThrow(RbacError);
    });

    it('throws for a support-level caller assigning a system role', () => {
      expect(() => assertCanAssignSystemRoles('support', [SUPERADMIN])).toThrow(RbacError);
    });

    it('names the offending system roles in the message', () => {
      try {
        assertCanAssignSystemRoles('admin', [SUPERADMIN, OWNER]);
        throw new Error('expected guard to throw');
      } catch (err) {
        expect((err as RbacError).message).toContain('superadmin');
        expect((err as RbacError).message).toContain('owner');
      }
    });
  });

  describe('allows legitimate assignments', () => {
    it('lets a Superadmin assign the Superadmin role', () => {
      expect(() => assertCanAssignSystemRoles('superadmin', [SUPERADMIN])).not.toThrow();
    });

    it('lets a Superadmin assign any mix including system roles', () => {
      expect(() =>
        assertCanAssignSystemRoles('superadmin', [SUPERADMIN, OWNER, ADMIN]),
      ).not.toThrow();
    });

    it('lets an admin assign non-system roles', () => {
      expect(() => assertCanAssignSystemRoles('admin', [ADMIN, SUPPORT, MEMBER])).not.toThrow();
    });

    it('is a no-op for an empty assignment set', () => {
      expect(() => assertCanAssignSystemRoles('admin', [])).not.toThrow();
      expect(() => assertCanAssignSystemRoles('support', [])).not.toThrow();
    });
  });
});
