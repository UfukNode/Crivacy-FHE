/**
 * System permission definitions — granular RBAC catalogue.
 *
 * Every atomic action that can be gated by a role is declared here as a
 * single permission. The seed script (`@/lib/rbac/seed`) writes this
 * catalogue into the `permissions` table; the middleware layer
 * (`dashboardRoute`, `adminRoute`) resolves the caller's effective set
 * at request time and short-circuits with a `permission_denied` error
 * when the required code is absent.
 *
 * Scope: **firm_user + admin_user** only. Customer endpoints are gated
 * by `customerRoute` on identity (session cookie proves ownership) and
 * do not consult this catalogue — customers uniformly have the same
 * implicit permission set on their own data.
 *
 * Naming convention: `{domain}.{subdomain?}.{action}[.{scope?}]`
 *   - Examples: `firm.user.invite`, `api_key.rotate.own`, `admin.firm.suspend`
 *   - `.own` / `.any` scope suffix distinguishes creator-only vs unrestricted.
 *   - `admin.*` prefix = admin panel only (never granted to firm_user roles).
 *
 * Design principles:
 *   1. **Granular over bulk**: every mutation has its own code. A bulk
 *      `manage_firms` code would force ban+unban to the same permission,
 *      which breaks the "unban = superadmin only" policy.
 *   2. **Scope suffixes over branching**: `api_key.rotate.own` vs
 *      `api_key.rotate.any` makes the "Member rotates own, Admin rotates
 *      any" policy explicit in the catalogue and checkable at one layer.
 *   3. **Target-type guards live in middleware**: `firm.user.role_change`
 *      is a single code, but the runtime check enforces "Admin cannot
 *      change Owner role" via a separate guard in the handler. We do
 *      not balloon codes with every target type.
 */

export interface PermissionDefinition {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly domain:
    | 'auth'
    | 'kyc'
    | 'credential'
    | 'ticket'
    | 'webhook'
    | 'firm'
    | 'admin'
    | 'system'
    | 'api_key'
    | 'oauth_client'
    | 'audit'
    | 'playground'
    | 'profile'
    | 'usage'
    | 'notifications';
}

export const SYSTEM_PERMISSIONS: readonly PermissionDefinition[] = [
  // ── Firm resource ─────────────────────────────────────────────────
  { code: 'firm.read', name: 'View Firm', description: 'Read firm profile and settings.', domain: 'firm' },
  { code: 'firm.update', name: 'Update Firm', description: 'Modify firm profile and settings.', domain: 'firm' },
  { code: 'firm.delete', name: 'Delete Firm', description: 'Soft-delete the firm. Owner-only action, irreversible without admin restore.', domain: 'firm' },
  { code: 'firm.transfer_ownership', name: 'Transfer Ownership', description: 'Reassign Owner role to another firm user. Owner-only.', domain: 'firm' },

  // ── Firm team (firm_users) ────────────────────────────────────────
  { code: 'firm.user.read', name: 'View Team', description: 'List firm users.', domain: 'firm' },
  { code: 'firm.user.invite', name: 'Invite Team Member', description: 'Send invitation to join the firm.', domain: 'firm' },
  { code: 'firm.user.role_change', name: 'Change Team Member Role', description: 'Change role of a non-owner firm user. Owner role changes require separate `firm.transfer_ownership` permission.', domain: 'firm' },
  { code: 'firm.user.remove', name: 'Remove Team Member', description: 'Remove a non-owner firm user. Cannot remove last owner (handler invariant).', domain: 'firm' },

  // ── API keys ──────────────────────────────────────────────────────
  { code: 'api_key.read', name: 'View API Keys', description: 'List firm API keys (key values not revealed).', domain: 'api_key' },
  { code: 'api_key.create', name: 'Create API Key', description: 'Mint a new firm API key. One-shot secret reveal.', domain: 'api_key' },
  { code: 'api_key.rotate.own', name: 'Rotate Own API Key', description: 'Rotate API keys the caller created. Member-tier scope.', domain: 'api_key' },
  { code: 'api_key.rotate.any', name: 'Rotate Any API Key', description: 'Rotate any firm API key regardless of creator.', domain: 'api_key' },
  { code: 'api_key.revoke.own', name: 'Revoke Own API Key', description: 'Revoke API keys the caller created.', domain: 'api_key' },
  { code: 'api_key.revoke.any', name: 'Revoke Any API Key', description: 'Revoke any firm API key regardless of creator.', domain: 'api_key' },

  // ── Webhooks ──────────────────────────────────────────────────────
  { code: 'webhook.read', name: 'View Webhooks', description: 'List webhook endpoints.', domain: 'webhook' },
  { code: 'webhook.create', name: 'Create Webhook', description: 'Register a new webhook endpoint.', domain: 'webhook' },
  { code: 'webhook.update', name: 'Update Webhook', description: 'Edit webhook URL, events, or toggle active.', domain: 'webhook' },
  { code: 'webhook.delete', name: 'Delete Webhook', description: 'Delete a webhook endpoint (irreversible).', domain: 'webhook' },
  { code: 'webhook.delivery.read', name: 'View Deliveries', description: 'List webhook delivery attempts and payloads.', domain: 'webhook' },
  { code: 'webhook.delivery.replay', name: 'Replay Delivery', description: 'Re-dispatch a past webhook delivery.', domain: 'webhook' },

  // ── OAuth clients ────────────────────────────────────────────────
  { code: 'oauth_client.read', name: 'View OAuth Clients', description: 'List firm OAuth clients.', domain: 'oauth_client' },
  { code: 'oauth_client.create', name: 'Create OAuth Client', description: 'Register a new OAuth client. One-shot client_secret reveal.', domain: 'oauth_client' },
  { code: 'oauth_client.update', name: 'Update OAuth Client', description: 'Edit OAuth client name, redirect URIs, scopes, consent TTL.', domain: 'oauth_client' },
  { code: 'oauth_client.rotate_secret', name: 'Rotate OAuth Client Secret', description: 'Mint a new client_secret (old one invalidated immediately).', domain: 'oauth_client' },
  { code: 'oauth_client.revoke', name: 'Revoke OAuth Client', description: 'Mark OAuth client as revoked; cascades to tokens and consents.', domain: 'oauth_client' },

  // ── Tickets (shared codes, used by firm_user + admin_user) ────────
  { code: 'ticket.create', name: 'Create Ticket', description: 'Open a new support ticket.', domain: 'ticket' },
  { code: 'ticket.read.own', name: 'View Own Tickets', description: 'View tickets the caller created or participates in.', domain: 'ticket' },
  { code: 'ticket.read.firm', name: 'View Firm Tickets', description: 'View all tickets within the caller\'s firm.', domain: 'ticket' },
  { code: 'ticket.reply', name: 'Reply to Ticket', description: 'Post a message on a ticket the caller can read.', domain: 'ticket' },
  { code: 'ticket.close.own', name: 'Close Own Ticket', description: 'Close tickets the caller created.', domain: 'ticket' },
  { code: 'ticket.close.any', name: 'Close Any Ticket', description: 'Close any ticket the caller can read.', domain: 'ticket' },
  { code: 'ticket.upload_attachment', name: 'Upload Attachment', description: 'Attach files to ticket messages.', domain: 'ticket' },

  // ── Audit log ─────────────────────────────────────────────────────
  { code: 'audit.read.firm', name: 'View Firm Audit Log', description: 'View audit events for the caller\'s firm.', domain: 'audit' },

  // ── Usage ─────────────────────────────────────────────────────────
  { code: 'usage.read', name: 'View Usage', description: 'View firm usage statistics and charts.', domain: 'usage' },

  // ── Playground ────────────────────────────────────────────────────
  { code: 'playground.execute', name: 'Execute Playground Request', description: 'Run API Playground requests against the firm\'s keys. Consumes quota.', domain: 'playground' },

  // ── Self-service profile (both firm_user + admin_user) ────────────
  { code: 'profile.update', name: 'Update Own Profile', description: 'Edit the caller\'s own profile fields.', domain: 'profile' },
  { code: 'profile.totp_manage', name: 'Manage Own TOTP', description: 'Set up, replace, or disable the caller\'s own TOTP.', domain: 'profile' },
  { code: 'profile.recovery_codes_regenerate', name: 'Regenerate Own Recovery Codes', description: 'Invalidate all old recovery codes and mint a new set for the caller.', domain: 'profile' },

  // ── Notifications (shared) ────────────────────────────────────────
  { code: 'notifications.read', name: 'View Notifications', description: 'List and view own notifications.', domain: 'notifications' },
  { code: 'notifications.manage', name: 'Manage Notifications', description: 'Mark notifications read, bulk operations on own notifications.', domain: 'notifications' },

  // ── Admin — firm management ───────────────────────────────────────
  { code: 'admin.firm.read', name: 'Admin: View Firms', description: 'List and inspect any firm in the system.', domain: 'admin' },
  { code: 'admin.firm.create', name: 'Admin: Create Firm', description: 'Provision a new firm (admin-initiated onboarding).', domain: 'admin' },
  { code: 'admin.firm.update', name: 'Admin: Update Firm', description: 'Edit any firm\'s profile, tier, or settings.', domain: 'admin' },
  { code: 'admin.firm.suspend', name: 'Admin: Suspend Firm', description: 'Temporarily disable a firm (reversible).', domain: 'admin' },
  { code: 'admin.firm.restore', name: 'Admin: Restore Firm', description: 'Lift a firm suspension or restore a soft-deleted firm. Superadmin-only.', domain: 'admin' },
  { code: 'admin.firm.firm_user.unlock', name: 'Admin: Unlock Firm User', description: 'Reset lockout counter on a firm user locked by failed logins.', domain: 'admin' },

  // ── Admin — customer management ───────────────────────────────────
  { code: 'admin.customer.read', name: 'Admin: View Customers', description: 'List and inspect any customer.', domain: 'admin' },
  { code: 'admin.customer.ban', name: 'Admin: Ban Customer', description: 'Permanently ban a customer (status→banned).', domain: 'admin' },
  { code: 'admin.customer.unban', name: 'Admin: Unban Customer', description: 'Lift a ban (status→active). Superadmin-only due to compliance impact.', domain: 'admin' },
  { code: 'admin.customer.avatar_upload', name: 'Admin: Moderate Customer Avatar', description: 'Replace or remove a customer\'s avatar (moderation).', domain: 'admin' },

  // ── Admin — tickets (admin-only actions; shared `ticket.*` codes cover common actions) ─
  { code: 'admin.ticket.read_all', name: 'Admin: View All Tickets', description: 'View every ticket across all firms and customers.', domain: 'admin' },
  { code: 'admin.ticket.take_over', name: 'Admin: Take Over Ticket', description: 'Reassign a ticket\'s assignee to self (supersede previous assignee).', domain: 'admin' },
  { code: 'admin.ticket.assign', name: 'Admin: Assign Ticket', description: 'Set or change a ticket\'s assignee.', domain: 'admin' },
  { code: 'admin.ticket.add_internal_note', name: 'Admin: Add Internal Note', description: 'Post a staff-visible-only note on a ticket.', domain: 'admin' },
  { code: 'admin.ticket.participants_manage', name: 'Admin: Manage Ticket Participants', description: 'Invite, remove, or change participant roles on a ticket.', domain: 'admin' },
  { code: 'admin.ticket.category_manage', name: 'Admin: Manage Ticket Categories', description: 'CRUD support ticket categories.', domain: 'admin' },

  // ── Admin — blacklist ─────────────────────────────────────────────
  { code: 'admin.blacklist.read', name: 'Admin: View Blacklist', description: 'List blacklisted customers and reasons.', domain: 'admin' },
  { code: 'admin.blacklist.manage', name: 'Admin: Manage Blacklist', description: 'Add or remove entries from the customer blacklist.', domain: 'admin' },

  // ── Admin — audit ─────────────────────────────────────────────────
  { code: 'admin.audit.read', name: 'Admin: View Audit Log', description: 'View platform-wide audit log across all firms.', domain: 'admin' },

  // ── Admin — status page ───────────────────────────────────────────
  { code: 'admin.status.component_manage', name: 'Admin: Manage Status Components', description: 'CRUD status page components.', domain: 'admin' },
  { code: 'admin.status.incident_manage', name: 'Admin: Manage Status Incidents', description: 'Open, update, and resolve status page incidents.', domain: 'admin' },

  // ── Admin — system ────────────────────────────────────────────────
  { code: 'admin.system.metrics_read', name: 'Admin: View System Metrics', description: 'Read platform-wide metrics dashboard.', domain: 'admin' },

  // ── Admin — RBAC meta ─────────────────────────────────────────────
  { code: 'admin.rbac.role_read', name: 'Admin: View Roles', description: 'List roles and their permission assignments.', domain: 'admin' },
  { code: 'admin.rbac.role_manage', name: 'Admin: Manage Roles', description: 'Create, update, and delete roles. Superadmin-only.', domain: 'admin' },
  { code: 'admin.rbac.permission_manage', name: 'Admin: Manage Permissions', description: 'Modify role→permission mappings. Superadmin-only (catalogue itself is code-seeded).', domain: 'admin' },
  { code: 'admin.rbac.user_role_assign', name: 'Admin: Assign User Roles', description: 'Assign or unassign roles to users. Assigning the Superadmin preset requires the caller to be Superadmin (handler guard).', domain: 'admin' },

  // ── Admin — admin user lifecycle ──────────────────────────────────
  { code: 'admin.user.read', name: 'Admin: View Admin Users', description: 'List admin user accounts.', domain: 'admin' },
  { code: 'admin.user.create', name: 'Admin: Create Admin User', description: 'Provision a new admin account. Superadmin-only.', domain: 'admin' },
  { code: 'admin.user.update', name: 'Admin: Update Admin User', description: 'Edit admin user profile. Editing an Admin or Superadmin target requires Superadmin (handler guard).', domain: 'admin' },
  { code: 'admin.user.delete', name: 'Admin: Delete Admin User', description: 'Soft-delete an admin account. Superadmin-only.', domain: 'admin' },
  { code: 'admin.user.totp_reset', name: 'Admin: Reset Admin TOTP', description: 'Force-reset another admin\'s TOTP binding. Superadmin-only.', domain: 'admin' },
] as const;

/**
 * Look up a permission definition by its code. Returns `undefined` if
 * no definition matches.
 */
export function getPermissionByCode(code: string): PermissionDefinition | undefined {
  return SYSTEM_PERMISSIONS.find(p => p.code === code);
}

/**
 * All permission codes as a `Set` for O(1) membership checks at runtime.
 * Used by validation layers that need to verify an incoming code string
 * is part of the known catalogue before hitting the database.
 */
export const ALL_PERMISSION_CODES: ReadonlySet<string> = new Set(
  SYSTEM_PERMISSIONS.map(p => p.code),
);

/**
 * Compile-time union of every catalogue code. Used by route handlers to
 * require a typed literal for the `permission` middleware option —
 * typos become compile errors instead of silent misses.
 */
export type PermissionCode = (typeof SYSTEM_PERMISSIONS)[number]['code'];
