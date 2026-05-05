/**
 * Permission checking utilities.
 *
 * Pure functions that operate on an already-resolved permission set
 * (from `@/lib/rbac/resolve`). No database access, no side effects —
 * these are trivially unit-testable and safe to call in hot paths like
 * middleware or render functions.
 *
 * All functions accept `ReadonlySet<string>` to enforce that callers
 * never accidentally mutate the permission set they received from the
 * resolver.
 */

/**
 * Check if a permission set contains the required permission.
 *
 * @param permissions - The resolved permission set for a user
 * @param required    - A single permission code to check (e.g. `"ticket:create"`)
 * @returns `true` if the permission is present
 */
export function hasPermission(permissions: ReadonlySet<string>, required: string): boolean {
  return permissions.has(required);
}

/**
 * Check if a permission set contains ALL of the required permissions.
 *
 * Use this when an action requires multiple permissions simultaneously
 * (e.g. viewing firm details AND viewing usage requires both
 * `firm:view` and `firm:view_usage`).
 *
 * @param permissions - The resolved permission set for a user
 * @param required    - Array of permission codes that must all be present
 * @returns `true` if every permission in the array is present
 */
export function hasAllPermissions(
  permissions: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  return required.every(p => permissions.has(p));
}

/**
 * Check if a permission set contains ANY of the required permissions.
 *
 * Use this when multiple permissions can satisfy the same gate
 * (e.g. a ticket detail page that is visible to anyone with
 * `ticket:view_own`, `ticket:view_assigned`, or `ticket:view_all`).
 *
 * @param permissions - The resolved permission set for a user
 * @param required    - Array of permission codes where at least one must be present
 * @returns `true` if at least one permission in the array is present
 */
export function hasAnyPermission(
  permissions: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  return required.some(p => permissions.has(p));
}
