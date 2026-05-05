/**
 * Preset role definitions — firm_user (4) + admin_user (3).
 *
 * Each preset maps a role name to its permission set. The seed script
 * (`@/lib/rbac/seed`) writes these into `roles` and `role_permissions`
 * on startup. Presets are `isPreset: true` and (where critical)
 * `isSystem: true` to block deletion from the admin RBAC UI.
 *
 * Scope decision (user, 2026-04-23): RBAC enforcement covers
 * firm_user + admin_user only. Customer endpoints are gated by
 * identity at `customerRoute` middleware (session cookie proves
 * ownership); customers do not carry a role in `user_roles` and their
 * self-service permission set is implicit. No `customer` preset lives
 * in this catalogue.
 *
 * Hierarchy decision (user, 2026-04-23): Seçenek B (explicit). Owner
 * is NOT a bypass — Owner gets the `owner` preset assignment in
 * `user_roles` like any other role, with a permission set that
 * inherits Admin + Owner-exclusive codes. A "last-owner invariant"
 * (Faz 14) prevents the demote/remove path from leaving a firm
 * owner-less.
 */

export interface PresetRoleDefinition {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly userType: 'firm_user' | 'admin_user';
  readonly isSystem: boolean;
  readonly permissions: readonly string[];
}

// ────────────────────────────────────────────────────────────────────
// FIRM_USER presets
// ────────────────────────────────────────────────────────────────────

/**
 * Viewer — audit / observer role. Read-only across firm resources plus
 * self-service profile management. Designed for compliance officers,
 * finance observers, and investor read-only dashboards.
 */
const FIRM_VIEWER_PERMISSIONS: readonly string[] = [
  // Firm + team visibility
  'firm.read',
  'firm.user.read',
  // Read-only resource views
  'api_key.read',
  'webhook.read',
  'webhook.delivery.read',
  'oauth_client.read',
  // Ticket team inbox — every firm_user (including Viewer as the
  // audit / observer role) can read and reply across the firm's
  // shared queue. Closing a ticket is still gated: `close.own` at
  // Member and `close.any` at Admin.
  'ticket.create',
  'ticket.read.own',
  'ticket.read.firm',
  'ticket.reply',
  'ticket.upload_attachment',
  // Usage statistics (no mutation)
  'usage.read',
  // Self-service profile (every user manages own credentials)
  'profile.update',
  'profile.totp_manage',
  'profile.recovery_codes_regenerate',
  'notifications.read',
  'notifications.manage',
] as const;

/**
 * Member — regular team member. Viewer + creates own resources and runs
 * playground. Can manage own API keys/webhooks (rotate/revoke own) but
 * cannot delete webhooks or touch other members' resources.
 */
const FIRM_MEMBER_PERMISSIONS: readonly string[] = [
  ...FIRM_VIEWER_PERMISSIONS,
  // Own API keys — create + lifecycle on own keys only
  'api_key.create',
  'api_key.rotate.own',
  'api_key.revoke.own',
  // Webhooks — create/update but not delete (irreversible)
  'webhook.create',
  'webhook.update',
  'webhook.delivery.replay',
  // Own ticket closing
  'ticket.close.own',
  // API Playground — consumes quota, needs deliberate role gate
  'playground.execute',
] as const;

/**
 * Admin — firm admin. Member + firm settings + team management + any
 * resource mutation + firm ticket oversight. Cannot delete the firm or
 * transfer ownership (Owner-only).
 */
const FIRM_ADMIN_PERMISSIONS: readonly string[] = [
  ...FIRM_MEMBER_PERMISSIONS,
  // Firm settings
  'firm.update',
  // Team management (invite, role change, remove — owner-target guard in handler)
  'firm.user.invite',
  'firm.user.role_change',
  'firm.user.remove',
  // Any-resource mutations
  'api_key.rotate.any',
  'api_key.revoke.any',
  'webhook.delete',
  'oauth_client.create',
  'oauth_client.update',
  'oauth_client.rotate_secret',
  'oauth_client.revoke',
  // Ticket oversight — Admin+ can force-close any ticket. Reading
  // firm-wide tickets is already granted to Viewer (team inbox).
  'ticket.close.any',
  // Audit
  'audit.read.firm',
] as const;

/**
 * Owner — firm founder. Admin + irreversible firm-level ops (delete,
 * transfer ownership). Marked `isSystem: true` so the preset cannot be
 * deleted. "Last owner invariant" (Faz 14) guards against the firm
 * ending up ownerless.
 */
const FIRM_OWNER_PERMISSIONS: readonly string[] = [
  ...FIRM_ADMIN_PERMISSIONS,
  'firm.delete',
  'firm.transfer_ownership',
] as const;

// ────────────────────────────────────────────────────────────────────
// ADMIN_USER presets
// ────────────────────────────────────────────────────────────────────

/**
 * Support — Crivacy customer support staff. Read-mostly access plus
 * ticket operations (take over, assign, add internal notes). Can view
 * audit log for own-action traceability. Cannot mutate firm/customer
 * state beyond unlocking firm users and moderating customer avatars.
 */
const ADMIN_SUPPORT_PERMISSIONS: readonly string[] = [
  // Read firms + customers
  'admin.firm.read',
  'admin.customer.read',
  // Firm user lockout relief (common support action)
  'admin.firm.firm_user.unlock',
  // Customer avatar moderation (strip inappropriate images)
  'admin.customer.avatar_upload',
  // Tickets — take over, assign, participants, internal notes
  'admin.ticket.read_all',
  'admin.ticket.take_over',
  'admin.ticket.assign',
  'admin.ticket.add_internal_note',
  'admin.ticket.participants_manage',
  // Shared ticket actions (reply, attach)
  'ticket.reply',
  'ticket.upload_attachment',
  // Audit visibility (support sees own and peer activity)
  'admin.audit.read',
  // Blacklist read (inform support of prior incidents)
  'admin.blacklist.read',
  // Roles view (to know "who is this admin" context)
  'admin.rbac.role_read',
  'admin.user.read',
  // Self-service profile
  'profile.update',
  'profile.totp_manage',
  'profile.recovery_codes_regenerate',
  'notifications.read',
  'notifications.manage',
] as const;

/**
 * Admin — platform admin. Support + firm/customer mutations + status
 * page management + system metrics + ability to assign roles to other
 * admins (but NOT Superadmin — handler guard prevents privilege
 * escalation).
 */
const ADMIN_ADMIN_PERMISSIONS: readonly string[] = [
  ...ADMIN_SUPPORT_PERMISSIONS,
  // Firm mutations (create, update, suspend; restore is Superadmin-only)
  'admin.firm.create',
  'admin.firm.update',
  'admin.firm.suspend',
  // Customer mutations (ban; unban is Superadmin-only)
  'admin.customer.ban',
  // Blacklist
  'admin.blacklist.manage',
  // Status page
  'admin.status.component_manage',
  'admin.status.incident_manage',
  // System metrics
  'admin.system.metrics_read',
  // Ticket categories
  'admin.ticket.category_manage',
  // Assign roles (target-role guard in handler: cannot assign Superadmin)
  'admin.rbac.user_role_assign',
] as const;

/**
 * Superadmin — full control. Admin + irreversible ops (unban, firm
 * restore) + RBAC meta (role/permission management) + admin user
 * lifecycle (create/update/delete/totp_reset). Marked `isSystem: true`.
 */
const ADMIN_SUPERADMIN_PERMISSIONS: readonly string[] = [
  ...ADMIN_ADMIN_PERMISSIONS,
  // Irreversible firm/customer ops
  'admin.firm.restore',
  'admin.customer.unban',
  // RBAC meta
  'admin.rbac.role_manage',
  'admin.rbac.permission_manage',
  // Admin user lifecycle
  'admin.user.create',
  'admin.user.update',
  'admin.user.delete',
  'admin.user.totp_reset',
] as const;

// ────────────────────────────────────────────────────────────────────
// Exported catalogue
// ────────────────────────────────────────────────────────────────────

export const PRESET_ROLES: readonly PresetRoleDefinition[] = [
  // Firm viewer
  {
    name: 'viewer',
    displayName: 'Viewer',
    description: 'Read-only access to firm details, usage, audit log, and own ticket activity. No resource mutations, no playground.',
    userType: 'firm_user',
    isSystem: false,
    permissions: FIRM_VIEWER_PERMISSIONS,
  },
  // Firm member
  {
    name: 'member',
    displayName: 'Member',
    description: 'Viewer plus own-resource mutations (create API keys, create/update webhooks), own ticket closing, and API Playground execution. Cannot delete webhooks, cannot manage team, cannot touch others\' API keys.',
    userType: 'firm_user',
    isSystem: false,
    permissions: FIRM_MEMBER_PERMISSIONS,
  },
  // Firm admin
  {
    name: 'admin',
    displayName: 'Admin',
    description: 'Member plus firm settings, team management, any-resource mutations (rotate any API key, delete webhook, full OAuth client CRUD), firm-wide ticket oversight, and audit log access. Cannot delete firm or transfer ownership.',
    userType: 'firm_user',
    isSystem: false,
    permissions: FIRM_ADMIN_PERMISSIONS,
  },
  // Firm owner
  {
    name: 'owner',
    displayName: 'Owner',
    description: 'Admin plus irreversible firm-level operations (soft-delete firm, transfer ownership). Cannot be deleted as a preset; at least one Owner must exist per firm (enforced at the handler).',
    userType: 'firm_user',
    isSystem: true,
    permissions: FIRM_OWNER_PERMISSIONS,
  },

  // Admin support
  {
    name: 'support',
    displayName: 'Support',
    description: 'Crivacy support staff. Read firms + customers, full ticket workflow (take over, assign, internal notes), blacklist visibility, audit log visibility. Cannot mutate firms, ban customers, or manage status page.',
    userType: 'admin_user',
    isSystem: false,
    permissions: ADMIN_SUPPORT_PERMISSIONS,
  },
  // Admin admin
  {
    name: 'admin',
    displayName: 'Admin',
    description: 'Support plus firm mutations (create, update, suspend), customer ban, blacklist management, status page management, system metrics. Can assign roles to other admins but cannot elevate anyone to Superadmin (handler guard).',
    userType: 'admin_user',
    isSystem: false,
    permissions: ADMIN_ADMIN_PERMISSIONS,
  },
  // Admin superadmin
  {
    name: 'superadmin',
    displayName: 'Superadmin',
    description: 'Full platform control. Admin plus irreversible operations (customer unban, firm restore), RBAC meta (role/permission management), and admin user lifecycle (create, update, delete, TOTP reset). Cannot be deleted as a preset; at least one Superadmin must exist (enforced at the handler).',
    userType: 'admin_user',
    isSystem: true,
    permissions: ADMIN_SUPERADMIN_PERMISSIONS,
  },
] as const;

/**
 * Look up a preset role by name and user type. Returns `undefined` if
 * no preset matches. Role names are only unique within a `userType` —
 * e.g. `admin` exists for both `firm_user` and `admin_user`.
 */
export function getPresetRole(
  name: string,
  userType: 'firm_user' | 'admin_user',
): PresetRoleDefinition | undefined {
  return PRESET_ROLES.find(r => r.name === name && r.userType === userType);
}

/**
 * Map an existing hierarchy role (from `firm_users.role` or
 * `admin_users.role`) to its preset role name. Used by the Faz 3
 * backfill migration to seed `user_roles` for existing users.
 */
export function hierarchyRoleToPresetName(
  role: 'owner' | 'admin' | 'member' | 'viewer' | 'superadmin' | 'support',
): string {
  // Preset names happen to equal the hierarchy role strings verbatim —
  // intentional. If the preset catalogue ever diverges from the
  // hierarchy enum, replace this with an explicit Record<string,string>
  // mapping rather than silently shadowing.
  return role;
}
