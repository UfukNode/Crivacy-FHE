// @vitest-environment node
/**
 * Subscribers — unit coverage for the audit + email handlers wired
 * into the security-events bus.
 *
 * Each subscriber is a pure function of (event, ctx) so the tests
 * mock the downstream writers (`writeAudit`, `dispatchPasswordChangedAlert`)
 * and assert the correct payload flows through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/audit/writer', () => ({
  writeAudit: vi.fn(async () => ({ id: 'audit-id-1' })),
}));
vi.mock('@/lib/auth/password-changed-alert', () => ({
  dispatchPasswordChangedAlert: vi.fn(async () => {}),
}));

import type { CrivacyDatabase } from '@/lib/db/client';

import { writeAudit } from '@/lib/audit/writer';
import { dispatchPasswordChangedAlert } from '@/lib/auth/password-changed-alert';
import { auditSubscriber, emailSubscriber } from '@/lib/security-events/subscribers';
import type { SecurityEventEnvelope } from '@/lib/security-events';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const NOW = new Date('2026-04-22T12:00:00.000Z');
const DB = { execute: vi.fn() } as unknown as CrivacyDatabase;
const CTX = { db: DB };

/** UUID v4 fixtures — the audit actor/target validators reject non-v4. */
const CUSTOMER_UUID = '44444444-4444-4444-8444-444444444444';

function buildPasswordChangedEvent(overrides: {
  eventType?: SecurityEventEnvelope['eventType'];
  subjectKind?: 'customer' | 'firm_user' | 'admin_user';
  subjectId?: string;
} = {}): SecurityEventEnvelope {
  return {
    id: 'ev-1',
    eventType: overrides.eventType ?? 'customer.password_changed',
    eventVersion: 1,
    subject: {
      kind: overrides.subjectKind ?? 'customer',
      id: overrides.subjectId ?? CUSTOMER_UUID,
    },
    payload: {
      auditContext: {
        ip: '203.0.113.1',
        userAgent: 'UA',
        // Must be a UUID v4 — the audit context validator rejects
        // anything else, which matches what the production emit-side
        // hands through.
        requestId: '11111111-1111-4111-8111-111111111111',
      },
      sessionId: 'sess-1',
      email: 'user@example.com',
      displayName: 'Example User',
      reason: 'changed',
      securityUrlPath: '/settings/security',
    },
    emittedAt: NOW,
  };
}

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('security-events/subscribers', () => {
  beforeEach(() => {
    vi.mocked(writeAudit).mockClear();
    vi.mocked(dispatchPasswordChangedAlert).mockClear();
  });

  /* ---------------------- auditSubscriber ---------------------- */

  describe('auditSubscriber', () => {
    it('writes the correct action for customer.password_changed', async () => {
      await auditSubscriber(buildPasswordChangedEvent(), CTX);

      expect(writeAudit).toHaveBeenCalledTimes(1);
      const entry = vi.mocked(writeAudit).mock.calls[0]?.[1];
      expect(entry?.action).toBe('customer.password_changed');
      expect(entry?.ts).toBe(NOW);
      expect(entry?.meta).toEqual({ sessionId: 'sess-1', reason: 'changed' });
    });

    it('writes the correct action for firm_user.password_changed', async () => {
      await auditSubscriber(
        buildPasswordChangedEvent({
          eventType: 'firm_user.password_changed',
          subjectKind: 'firm_user',
          subjectId: '22222222-2222-4222-8222-222222222222',
        }),
        CTX,
      );

      const entry = vi.mocked(writeAudit).mock.calls[0]?.[1];
      expect(entry?.action).toBe('firm_user.password_changed');
    });

    it('writes the correct action for admin_user.password_changed', async () => {
      await auditSubscriber(
        buildPasswordChangedEvent({
          eventType: 'admin_user.password_changed',
          subjectKind: 'admin_user',
          subjectId: '33333333-3333-4333-8333-333333333333',
        }),
        CTX,
      );

      const entry = vi.mocked(writeAudit).mock.calls[0]?.[1];
      expect(entry?.action).toBe('admin_user.password_changed');
    });

    it('maps password_reset to the *_completed audit action', async () => {
      await auditSubscriber(
        buildPasswordChangedEvent({ eventType: 'customer.password_reset' }),
        CTX,
      );

      const entry = vi.mocked(writeAudit).mock.calls[0]?.[1];
      expect(entry?.action).toBe('customer.password_reset_completed');
    });

    it('skips events without a mapped audit action (no throw)', async () => {
      // wallet_linked has no audit action + no payload schema
      // registered yet, so the subscriber short-circuits.
      await auditSubscriber(
        buildPasswordChangedEvent({ eventType: 'customer.wallet_linked' }),
        CTX,
      );

      expect(writeAudit).not.toHaveBeenCalled();
    });

    it('rebuilds the audit request context from the event payload', async () => {
      await auditSubscriber(buildPasswordChangedEvent(), CTX);

      const entry = vi.mocked(writeAudit).mock.calls[0]?.[1];
      // The audit context should carry the IP / UA / requestId we
      // captured at emit time. `buildRequestContext` normalises but
      // preserves the shape, so the round-trip is assertable by
      // checking the ip field.
      expect(entry?.context?.ip).toBe('203.0.113.1');
    });
  });

  /* ---------------------- emailSubscriber ---------------------- */

  describe('emailSubscriber', () => {
    it('dispatches a password-changed alert for customer', async () => {
      await emailSubscriber(buildPasswordChangedEvent(), CTX);

      expect(dispatchPasswordChangedAlert).toHaveBeenCalledTimes(1);
      const args = vi.mocked(dispatchPasswordChangedAlert).mock.calls[0]?.[0];
      expect(args?.audience).toBe('customer');
      expect(args?.userId).toBe(CUSTOMER_UUID);
      expect(args?.email).toBe('user@example.com');
      expect(args?.reason).toBe('changed');
      expect(args?.securityUrlPath).toBe('/settings/security');
      expect(args?.now).toBe(NOW);
    });

    it('maps firm_user → firm audience', async () => {
      await emailSubscriber(
        buildPasswordChangedEvent({
          subjectKind: 'firm_user',
          eventType: 'firm_user.password_changed',
        }),
        CTX,
      );

      const args = vi.mocked(dispatchPasswordChangedAlert).mock.calls[0]?.[0];
      expect(args?.audience).toBe('firm');
    });

    it('maps admin_user → admin audience', async () => {
      await emailSubscriber(
        buildPasswordChangedEvent({
          subjectKind: 'admin_user',
          eventType: 'admin_user.password_changed',
        }),
        CTX,
      );

      const args = vi.mocked(dispatchPasswordChangedAlert).mock.calls[0]?.[0];
      expect(args?.audience).toBe('admin');
    });

    it('does not dispatch the password alert for non-password event types', async () => {
      // `customer.email_added` is the canonical "no email subscriber"
      // event family — used here to assert that emailSubscriber does
      // not blanket-dispatch the password alert for unrelated events.
      // Other event types (TOTP / lockout / link / recovery) do enqueue
      // their own templates via `enqueueEmailFromRoute`, covered in the
      // dedicated branch tests; this test pins the narrow contract that
      // `dispatchPasswordChangedAlert` is password-family only.
      await emailSubscriber(
        buildPasswordChangedEvent({ eventType: 'customer.email_added' }),
        CTX,
      );

      expect(dispatchPasswordChangedAlert).not.toHaveBeenCalled();
    });

    it('threads the null email through unchanged (dispatcher no-ops it)', async () => {
      const event = buildPasswordChangedEvent();
      // Mutate payload to simulate a wallet-only customer with no email.
      const payloadWithoutEmail = { ...event.payload, email: null };
      await emailSubscriber(
        { ...event, payload: payloadWithoutEmail },
        CTX,
      );

      const args = vi.mocked(dispatchPasswordChangedAlert).mock.calls[0]?.[0];
      expect(args?.email).toBeNull();
    });
  });
});
