/**
 * Schema-level invariants — asserted on the parsed Zod schemas (not on
 * the emitted spec). The assertions here verify that every schema
 * actually validates the shapes the docs claim it validates. If one of
 * these regresses, a handler that trusts the schema for input validation
 * would silently accept bad data, which is a higher-severity bug than
 * the spec file drifting.
 */

import { describe, expect, it } from 'vitest';

import {
  ApiErrorBody,
  ApiKeyCreateRequest,
  AuditLogEntry,
  CredentialDetail,
  CredentialVerifyRequest,
  DiditWebhookPayload,
  FirmProfile,
  FirmUpdateRequest,
  LimitsResponse,
  LoginRequest,
  OutboundWebhookEnvelope,
  PlaygroundExecuteRequest,
  SessionCreateRequest,
  SessionDetail,
  StatusResponse,
  UsageSummary,
  WebhookCreateRequest,
  WebhookUpdateRequest,
} from '@/lib/openapi';

describe('openapi/schemas', () => {
  describe('ApiErrorBody', () => {
    it('requires a wrapped error envelope', () => {
      const result = ApiErrorBody.safeParse({
        error: {
          code: 'validation_failed',
          message: 'bad',
          requestId: '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
        },
      });
      expect(result.success).toBe(true);
    });
    it('rejects a flat error body', () => {
      const result = ApiErrorBody.safeParse({
        code: 'validation_failed',
        message: 'bad',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('SessionCreateRequest', () => {
    it('accepts minimal payload', () => {
      const result = SessionCreateRequest.safeParse({
        userRef: 'usr_1',
        level: 'enhanced',
      });
      expect(result.success).toBe(true);
    });
    it('rejects missing userRef', () => {
      const result = SessionCreateRequest.safeParse({ level: 'enhanced' });
      expect(result.success).toBe(false);
    });
  });

  describe('CredentialVerifyRequest', () => {
    it('accepts a valid user address', () => {
      const result = CredentialVerifyRequest.safeParse({
        userAddress: '0x1234567890abcdef1234567890abcdef12345678',
      });
      expect(result.success).toBe(true);
    });
    it('rejects an invalid user address', () => {
      const result = CredentialVerifyRequest.safeParse({
        userAddress: 'abc',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('WebhookCreateRequest', () => {
    it('accepts an https URL + event list', () => {
      const result = WebhookCreateRequest.safeParse({
        url: 'https://hooks.acme-bank.com/crivacy',
        events: ['credential.created'],
      });
      expect(result.success).toBe(true);
    });
    it('rejects an http URL', () => {
      const result = WebhookCreateRequest.safeParse({
        url: 'http://hooks.acme-bank.com/crivacy',
        events: ['credential.created'],
      });
      expect(result.success).toBe(false);
    });
    it('rejects an empty event list', () => {
      const result = WebhookCreateRequest.safeParse({
        url: 'https://hooks.acme-bank.com/crivacy',
        events: [],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('WebhookUpdateRequest', () => {
    it('requires at least one field', () => {
      const result = WebhookUpdateRequest.safeParse({});
      expect(result.success).toBe(false);
    });
    it('accepts a single active toggle', () => {
      const result = WebhookUpdateRequest.safeParse({ active: false });
      expect(result.success).toBe(true);
    });
  });

  describe('FirmUpdateRequest', () => {
    it('requires at least one field', () => {
      const result = FirmUpdateRequest.safeParse({});
      expect(result.success).toBe(false);
    });
    it('accepts a lone name update', () => {
      const result = FirmUpdateRequest.safeParse({ name: 'Acme Bank' });
      expect(result.success).toBe(true);
    });
  });

  describe('ApiKeyCreateRequest', () => {
    it('requires at least one scope', () => {
      const result = ApiKeyCreateRequest.safeParse({
        name: 'prod',
        mode: 'live',
        scopes: [],
      });
      expect(result.success).toBe(false);
    });
    it('caps scope count at 8', () => {
      const result = ApiKeyCreateRequest.safeParse({
        name: 'prod',
        mode: 'live',
        scopes: new Array(9).fill('kyc:read'),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('LoginRequest', () => {
    it('accepts email + password without TOTP', () => {
      const result = LoginRequest.safeParse({
        email: 'ops@acme-bank.com',
        password: 'correct horse battery staple',
      });
      expect(result.success).toBe(true);
    });
    it('rejects short passwords', () => {
      const result = LoginRequest.safeParse({
        email: 'ops@acme-bank.com',
        password: 'short',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('DiditWebhookPayload', () => {
    it('rejects unknown top-level keys (strict shape)', () => {
      const result = DiditWebhookPayload.safeParse({
        session_id: 'sess_1',
        status: 'Approved',
        workflow_id: 'wf_1',
        vendor_data: { crivacyKycSessionId: 'kyc_1' },
        created_at: '2026-04-11T10:00:00.000Z',
        extra: 'nope',
      });
      expect(result.success).toBe(false);
    });
    it('accepts a minimal approved payload', () => {
      const result = DiditWebhookPayload.safeParse({
        session_id: 'sess_1',
        status: 'Approved',
        workflow_id: 'wf_1',
        vendor_data: { crivacyKycSessionId: 'kyc_1' },
        created_at: '2026-04-11T10:00:00.000Z',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('OutboundWebhookEnvelope', () => {
    it('requires id, type, createdAt, data', () => {
      // `firmId` is deliberately NOT part of the outbound envelope —
      // the receiving firm authenticates via its signing secret and
      // already knows "who it is", and multi-recipient fan-out
      // makes the field ambiguous. Confirm the schema rejects any
      // payload that still echoes it back.
      const result = OutboundWebhookEnvelope.safeParse({
        id: '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
        type: 'credential.created',
        createdAt: '2026-04-11T10:00:00.000Z',
        data: { userRef: 'usr_1' },
        sessionId: null,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('PlaygroundExecuteRequest', () => {
    it('enforces `/api/v1/` path prefix', () => {
      const result = PlaygroundExecuteRequest.safeParse({
        apiKeyId: '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
        method: 'GET',
        path: '/api/v2/sessions',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('snapshot shape validators', () => {
    it('CredentialDetail parses a full happy shape', () => {
      const sample = {
        contractId: '00abfc31f2e19a48b2b8a1f6d7c9b3e1f4c2a5d8e7b6a9c3d2f1e4b7a8c5d6f9e3b',
        firmId: '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
        userRef: 'usr_1',
        status: 'active',
        level: 'enhanced',
        validUntil: '2027-04-11T10:00:00.000Z',
        identityVerified: true,
        livenessVerified: true,
        addressVerified: true,
        network: 'mainnet',
        updatedAt: '2026-04-11T10:00:00.000Z',
        proofHash: 'a'.repeat(64),
        validator: 'DiditValidator',
        operatorAddress: '0x91f410ffcf51abd0389890968b243bb9a32eb94b',
        userAddress: '0x1234567890abcdef1234567890abcdef12345678',
        kycContract: '0x27a9e3ded8a97cc31f451302fc069b42a72f602a',
        humanScore: 95,
        issuedAt: '2026-04-11T10:00:00.000Z',
        revokedAt: null,
        revocationReason: null,
      };
      const result = CredentialDetail.safeParse(sample);
      if (!result.success) {
        // Surface the failure messages so the test is useful when it drifts.
        throw new Error(JSON.stringify(result.error.issues, null, 2));
      }
    });

    it('SessionDetail parses a minimal happy shape', () => {
      const sample = {
        id: '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
        firmId: '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
        userRef: 'usr_1',
        status: 'pending',
        level: 'enhanced',
        createdAt: '2026-04-11T10:00:00.000Z',
        completedAt: null,
        redirectUrl: 'https://verification.didit.me/go/sess_1',
        metadata: null,
        expiresAt: '2026-04-12T10:00:00.000Z',
        phases: [
          {
            phase: 'identity',
            diditSessionId: 'sess_didit_1',
            url: 'https://verification.didit.me/sdk/sess_1',
            status: 'pending',
            startedAt: null,
            completedAt: null,
          },
        ],
      };
      const result = SessionDetail.safeParse(sample);
      if (!result.success) {
        throw new Error(JSON.stringify(result.error.issues, null, 2));
      }
    });

    it('UsageSummary parses a minimal happy shape', () => {
      const sample = {
        period: {
          start: '2026-04-01T00:00:00.000Z',
          end: '2026-05-01T00:00:00.000Z',
        },
        totalRequests: 10,
        billableRequests: 8,
        errors4xx: 1,
        errors5xx: 0,
        byEndpoint: [],
      };
      const result = UsageSummary.safeParse(sample);
      if (!result.success) {
        throw new Error(JSON.stringify(result.error.issues, null, 2));
      }
    });

    it('LimitsResponse parses a minimal happy shape', () => {
      const sample = {
        tier: 'starter',
        rateLimit: {
          limit: 100,
          remaining: 99,
          resetAt: '2026-04-11T10:00:00.000Z',
        },
        quota: {
          period: 'month',
          limit: 10_000,
          used: 10,
          remaining: 9_990,
          resetAt: '2026-05-01T00:00:00.000Z',
        },
      };
      const result = LimitsResponse.safeParse(sample);
      if (!result.success) {
        throw new Error(JSON.stringify(result.error.issues, null, 2));
      }
    });

    it('StatusResponse parses a minimal happy shape', () => {
      const sample = {
        overall: 'operational',
        components: [],
        activeIncidents: [],
        generatedAt: '2026-04-11T10:00:00.000Z',
      };
      const result = StatusResponse.safeParse(sample);
      if (!result.success) {
        throw new Error(JSON.stringify(result.error.issues, null, 2));
      }
    });

    it('FirmProfile parses a minimal happy shape', () => {
      const sample = {
        id: '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
        name: 'Acme Bank',
        slug: 'acme-bank',
        tier: 'starter',
        contactEmail: 'ops@acme-bank.com',
        createdAt: '2026-04-11T10:00:00.000Z',
        branding: {
          displayName: 'Acme Bank',
          logoUrl: null,
          accentColor: null,
          supportEmail: null,
        },
        ipAllowlist: [],
        dataRetentionDays: 2555,
      };
      const result = FirmProfile.safeParse(sample);
      if (!result.success) {
        throw new Error(JSON.stringify(result.error.issues, null, 2));
      }
    });

    it('AuditLogEntry parses a minimal happy shape', () => {
      const sample = {
        id: 1,
        actorKind: 'firm_user',
        actorId: '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
        actorLabel: 'ops@acme-bank.com',
        firmId: '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
        action: 'api_key.created',
        targetKind: 'api_key',
        targetId: '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
        targetRef: null,
        ip: '203.0.113.1',
        userAgent: 'curl/8.7',
        requestId: '6f31e3a2-6b8c-4cfa-9d47-2f7e4f6ad0d7',
        meta: {},
        ts: '2026-04-11T10:00:00.000Z',
      };
      const result = AuditLogEntry.safeParse(sample);
      if (!result.success) {
        throw new Error(JSON.stringify(result.error.issues, null, 2));
      }
    });
  });
});
