/**
 * Tests for the audit-action taxonomy.
 *
 * These tests pin the set of legal `action` strings. The taxonomy
 * is a closed value space — adding, removing, or renaming an action
 * is a breaking change, so the tests snapshot the full set and
 * assert structural invariants that callers depend on:
 *
 *   * Every action follows `domain.entity[.verb]` shape.
 *   * Every value is unique.
 *   * Each key maps to a same-string value (the map is a brand).
 *   * `isAuditAction` is a proper runtime guard.
 *   * `auditActionDomain` extracts the part before the first dot.
 *   * `ALL_AUDIT_ACTIONS` is frozen.
 *
 * When a new action is introduced, add it to both `actions.ts` and
 * to the SNAPSHOT_SET in this file. The test will fail until the
 * sets match — that is intentional and flags the reviewer.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_AUDIT_ACTIONS,
  AUDIT_ACTIONS,
  type AuditAction,
  auditActionDomain,
  isAuditAction,
} from '@/lib/audit';

/**
 * The full pinned set, alphabetically sorted. Acts as a
 * breaking-change signal: adding / removing / renaming an action
 * fails this test and the reviewer has to accept the delta here
 * AND in `src/lib/audit/actions.ts`. That second edit prevents a
 * taxonomy change from slipping through unnoticed in a PR.
 *
 * If a new action lands and this list needs an update, the whole
 * list is one `expect(...).toEqual(...)` assertion — the CI failure
 * shows exactly what's missing.
 */
const SNAPSHOT_SET: readonly AuditAction[] = [
  'access.permission_denied',
  'admin_user.created',
  'admin_user.customer_viewed',
  'admin_user.deleted',
  'admin_user.firm_viewed',
  'admin_user.impersonation_ended',
  'admin_user.impersonation_started',
  'admin_user.login.failed',
  'admin_user.login.success',
  'admin_user.login.turnstile_failed',
  'admin_user.password_changed',
  'admin_user.recovery_codes_regenerated',
  'admin_user.role_changed',
  'admin_user.session.refreshed',
  'admin_user.session.reuse_detected',
  'admin_user.ticket_viewed',
  'admin_user.totp_disabled',
  'admin_user.totp_enabled',
  'api_key.auth.failed',
  'api_key.issued',
  'api_key.last_used_updated',
  'api_key.playground_used',
  'api_key.revoked',
  'api_key.rotated',
  'auth.rate_limit_fired',
  'blacklist.added',
  'blacklist.removed',
  'compliance.data_export_requested',
  'compliance.data_exported',
  'compliance.erasure_requested',
  'compliance.meta_redacted',
  'credential.chain_error',
  'credential.customer_bound',
  'credential.disclosed',
  'credential.firm_disclosed',
  'credential.firm_issued',
  'credential.issued',
  'credential.revoked',
  'credential.verified',
  'customer.activated',
  'customer.avatar_removed',
  'customer.avatar_updated',
  'customer.banned',
  'customer.credential_issued',
  'customer.credential_superseded',
  'customer.credential_upgraded',
  'customer.email_added',
  'customer.email_change_initiated',
  'customer.email_changed',
  'customer.email_verified',
  'customer.fraud_detected',
  'customer.google_linked',
  'customer.google_login',
  'customer.google_registered',
  'customer.google_unlinked',
  'customer.kyc_completed',
  'customer.kyc_expired',
  'customer.kyc_failed',
  'customer.kyc_in_review',
  'customer.kyc_reset',
  'customer.kyc_resubmission_requested',
  'customer.kyc_revoked_by_didit_user',
  'customer.kyc_started',
  'customer.locked',
  'customer.login.failed',
  'customer.login.oauth.account_linked',
  'customer.login.oauth.failed',
  'customer.login.oauth.replay_blocked',
  'customer.login.oauth.status_promoted',
  'customer.login.oauth.sub_collision',
  'customer.login.oauth.success',
  'customer.login.success',
  'customer.login.turnstile_failed',
  'customer.logout',
  'customer.nft_minted',
  'customer.notification_prefs_updated',
  'customer.oauth_failed',
  'customer.onboarding_dismissed',
  'customer.password_changed',
  'customer.password_reset_completed',
  'customer.password_reset_requested',
  'customer.password_set',
  'customer.phone_updated',
  'customer.profile_updated',
  'customer.reauth.failed',
  'customer.reauth.rate_limited',
  'customer.reauth.success',
  'customer.registered',
  'customer.registration_attempt_existing',
  'customer.session.created',
  'customer.session.revoked',
  'customer.session.revoked_all',
  'customer.session.reuse_detected',
  'customer.suspended',
  'customer.unbanned',
  'customer.unlocked',
  'customer.wallet_linked',
  'customer.wallet_login',
  'customer.wallet_login_failed',
  'customer.wallet_registered',
  'customer.wallet_unlinked',
  'email.password_reset_sent',
  'email.send_failed',
  'fraud.kyc_decline_locked',
  'fraud.kyc_decline_reset',
  'fraud.kyc_decline_strike',
  'kyc_reconciler.stuck_mint_detected',
  'kyc_reconciler.stuck_mint_resolved',
  'kyc_reconciler.stuck_nft_mint_detected',
  'kyc_reconciler.stuck_nft_mint_resolved',
  'email.verification_sent',
  'firm.created',
  'firm.deleted',
  'firm.restored',
  'firm.tier_changed',
  'firm.updated',
  'firm.user_accepted',
  'firm.user_invite_expired',
  'firm.user_invited',
  'firm.user_removed',
  'firm.user_role_changed',
  'firm.user_unlocked',
  'firm_user.accepted_invite',
  'firm_user.invited',
  'firm_user.login.failed',
  'firm_user.login.success',
  'firm_user.login.turnstile_failed',
  'firm_user.logout',
  'firm_user.password_changed',
  'firm_user.password_reset_completed',
  'firm_user.password_reset_requested',
  'firm_user.recovery_code_used',
  'firm_user.recovery_codes_generated',
  'firm_user.recovery_codes_regenerated',
  'firm_user.removed',
  'firm_user.role_changed',
  'firm_user.session.refreshed',
  'firm_user.session.reuse_detected',
  'firm_user.totp_disabled',
  'firm_user.totp_enabled',
  'fraud.cascade_banned',
  'fraud.face_match_blocked',
  'fraud.repeat_evader_detected',
  'incident.opened',
  'incident.resolved',
  'incident.updated',
  'kyc_reconciler.drift_detected',
  'kyc_reconciler.drift_resolved',
  'kyc_reconciler.phase_address_missing_identity_prereq',
  'kyc_reconciler.reverse_drift_resolved',
  'kyc_reconciler.skipped_revoked_customer',
  'kyc_session.cancelled',
  'kyc_session.created',
  'kyc_session.decision_received',
  'kyc_session.expired',
  'kyc_session.identity_approved',
  'kyc_session.identity_rejected',
  'kyc_session.started',
  'kyc_session.webhook_received',
  'kyc_session.webhook_unknown_status',
  'notification.created',
  'oauth.client_secret_locked',
  'oauth.code_reuse_detected',
  'oauth.userinfo_first_use',
  'oauth_client.created',
  'oauth_client.revoked',
  'oauth_client.secret_rotated',
  'oauth_client.updated',
  'oauth_consent.granted',
  'oauth_consent.revoked',
  'ratelimit.quota_exceeded',
  'ratelimit.rate_limited',
  'role.assigned',
  'role.created',
  'role.deleted',
  'role.permission_granted',
  'role.permission_revoked',
  'role.unassigned',
  'role.updated',
  'status_component.state_changed',
  'system.backup.completed',
  'system.backup.started',
  'system.backup.verified',
  'system.migration.applied',
  'system.worker.started',
  'system.worker.stopped',
  'ticket.assigned',
  'ticket.assignee_transferred',
  'ticket.attachment_uploaded',
  'ticket.auto_assigned',
  'ticket.category_admin_added',
  'ticket.category_admin_removed',
  'ticket.category_created',
  'ticket.category_deactivated',
  'ticket.category_deleted',
  'ticket.category_updated',
  'ticket.closed',
  'ticket.created',
  'ticket.invite_expired',
  'ticket.invite_rescinded',
  'ticket.mention_created',
  'ticket.mention_revoked',
  'ticket.message_added',
  'ticket.message_edited',
  'ticket.participant_accepted',
  'ticket.participant_declined',
  'ticket.participant_invited',
  'ticket.participant_joined',
  'ticket.participant_left',
  'ticket.participant_muted',
  'ticket.participant_removed',
  'ticket.participant_unmuted',
  'ticket.resolved',
  'ticket.status_changed',
  'ticket.taken_over',
  'ticket.unassigned',
  'webhook.endpoint_created',
  'webhook.endpoint_deleted',
  'webhook.endpoint_tested',
  'webhook.endpoint_updated',
  'webhook_delivery.dead_lettered',
  'webhook_delivery.delivered',
  'webhook_delivery.failed',
  'webhook_delivery.retried',
  'webhook_delivery.scheduled',
  'webhook_endpoint.created',
  'webhook_endpoint.deleted',
  'webhook_endpoint.disabled',
  'webhook_endpoint.enabled',
  'webhook_endpoint.secret_rotated',
  'webhook_endpoint.updated',
];

describe('AUDIT_ACTIONS taxonomy', () => {
  it('matches the pinned snapshot set exactly', () => {
    expect([...ALL_AUDIT_ACTIONS].sort()).toEqual([...SNAPSHOT_SET].sort());
  });

  it('every action has domain.entity[.verb[.modifier]] shape', () => {
    // Up to 4 dot-separated segments — 4-segment names accommodate
    // the OAuth login event family `customer.login.oauth.<event>`
    // (success / failed / account_linked / status_promoted /
    // sub_collision / replay_blocked) added by F-A2-I1-001.
    for (const action of ALL_AUDIT_ACTIONS) {
      expect(action).toMatch(/^[a-z_]+(\.[a-z_]+){1,3}$/);
    }
  });

  it('contains no duplicates', () => {
    const set = new Set(ALL_AUDIT_ACTIONS);
    expect(set.size).toBe(ALL_AUDIT_ACTIONS.length);
  });

  it('every key maps to a same-string value in AUDIT_ACTIONS', () => {
    for (const [key, value] of Object.entries(AUDIT_ACTIONS)) {
      expect(value).toBe(key);
    }
  });

  it('ALL_AUDIT_ACTIONS is frozen', () => {
    expect(Object.isFrozen(ALL_AUDIT_ACTIONS)).toBe(true);
  });
});

describe('isAuditAction', () => {
  it('accepts every member of the pinned set', () => {
    for (const action of ALL_AUDIT_ACTIONS) {
      expect(isAuditAction(action)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isAuditAction('firm_user.login')).toBe(false);
    expect(isAuditAction('firm_user.login.success.extra')).toBe(false);
    expect(isAuditAction('FIRM_USER.LOGIN.SUCCESS')).toBe(false);
    expect(isAuditAction('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isAuditAction(undefined)).toBe(false);
    expect(isAuditAction(null)).toBe(false);
    expect(isAuditAction(42)).toBe(false);
    expect(isAuditAction({})).toBe(false);
    expect(isAuditAction(['firm.created'])).toBe(false);
  });
});

describe('auditActionDomain', () => {
  it('extracts the top-level domain of each action', () => {
    expect(auditActionDomain('firm.created')).toBe('firm');
    expect(auditActionDomain('firm_user.login.success')).toBe('firm_user');
    expect(auditActionDomain('system.backup.started')).toBe('system');
    expect(auditActionDomain('credential.verified')).toBe('credential');
  });

  it('every action resolves to a non-empty domain', () => {
    for (const action of ALL_AUDIT_ACTIONS) {
      const domain = auditActionDomain(action);
      expect(domain.length).toBeGreaterThan(0);
      expect(domain).not.toContain('.');
    }
  });

  it('there are no orphan domains — every domain has at least one member', () => {
    const domains = new Set(ALL_AUDIT_ACTIONS.map((a) => auditActionDomain(a)));
    // Spot-check: every top-level domain the product currently
    // emits audit rows for. Sorted alphabetically so additions
    // land in an obvious place.
    const expected = new Set([
      'access',
      'admin_user',
      'api_key',
      'auth',
      'blacklist',
      'compliance',
      'credential',
      'customer',
      'email',
      'firm',
      'firm_user',
      // Sprint 6 — face-match cascade audit domain (cascade_banned,
      // face_match_blocked, repeat_evader_detected).
      'fraud',
      'incident',
      'kyc_reconciler',
      'kyc_session',
      'notification',
      'oauth',
      'oauth_client',
      'oauth_consent',
      'ratelimit',
      'role',
      'status_component',
      'system',
      'ticket',
      'webhook',
      'webhook_delivery',
      'webhook_endpoint',
    ]);
    expect(domains).toEqual(expected);
  });
});
