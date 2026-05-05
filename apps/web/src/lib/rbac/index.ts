/**
 * `@/lib/rbac` barrel — the single import path for all RBAC functionality.
 *
 * Consumers should always import from `@/lib/rbac` rather than reaching
 * into the individual module files. This keeps the public API surface
 * explicit and lets us refactor internals without sweeping the codebase.
 *
 * Example usage:
 *
 *   import {
 *     resolveEffectivePermissions,
 *     hasPermission,
 *     hasAllPermissions,
 *     seedRbac,
 *     assignRoleToUser,
 *     RbacError,
 *   } from '@/lib/rbac';
 */

export * from './errors';
export * from './permissions';
export * from './roles';
export * from './resolve';
export * from './check';
export * from './seed';
export * from './assignment';
export * from './sync';
