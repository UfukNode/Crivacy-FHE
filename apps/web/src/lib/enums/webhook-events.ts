/**
 * UI metadata for `WebhookEventType` values.
 *
 * The canonical enum lives in `lib/openapi/schemas/enums.ts` — that
 * file defines the wire-level string literal union that both the
 * API and the OpenAPI spec export. This module adds the labels +
 * descriptions the dashboard UI needs to render event checkboxes,
 * but never invents values: the metadata keys are pinned to the
 * canonical enum via `satisfies Record<WebhookEventType, ...>`, so
 * adding a value to the enum without a metadata entry (or vice
 * versa) is a compile error. That replaces the previous
 * /dashboard/webhooks page's drift risk, where a UI checkbox could
 * reference an event name the backend never fired.
 *
 * @module
 */

import type { z } from 'zod';

import { WebhookEventType } from '@/lib/openapi/schemas/enums';

export type WebhookEvent = z.infer<typeof WebhookEventType>;

/**
 * Iteration-stable list of every webhook event the product
 * currently emits. Consumers should map over this array when
 * rendering lists (checkboxes, option tags) instead of duplicating
 * the string literals.
 */
export const WEBHOOK_EVENT_VALUES: readonly WebhookEvent[] =
  WebhookEventType.options;

/**
 * Human-friendly labels + one-line descriptions + search keywords
 * per event. Used by the webhook subscription form and the
 * playground enum overlay.
 *
 * `satisfies Record<WebhookEvent, ...>` turns missing entries into
 * a TS error at build time — if you add a new value to
 * `WebhookEventType` you MUST add metadata here before the build
 * passes.
 *
 * `keywords` carries search synonyms — words a developer might type
 * while hunting for the event from a different mental model
 * (action verbs, mental aliases, adjacent product vocabulary). The
 * dashboard's webhook dialog runs a case-insensitive substring
 * match against `name + label + description + keywords` so typing
 * `create` or `new user` or `first-time` all surface
 * `credential.created`. Keep the list tight; this is a hint, not
 * a thesaurus.
 */
export const WEBHOOK_EVENT_METADATA = {
  'credential.created': {
    label: 'Credential issued',
    description: 'A new KYC credential was issued for a customer.',
    keywords: ['new', 'create', 'issue', 'onboard', 'first', 'mint', 'customer'],
    trigger:
      'Fires once, right after Crivacy writes the credential metadata row. The on-chain contract may still be minting — wait for `credential.verified` to treat the proof hash as trusted.',
    samplePayload: {
      id: 'cr_9f8e7d6c',
      userRef: 'usr_9f8e7d6c',
      level: 'basic',
      status: 'issued',
      proofHash: 'sha256:…',
      validUntil: '2027-04-19T00:00:00Z',
      createdAt: '2026-04-19T10:24:11Z',
    },
  },
  'credential.verified': {
    label: 'Credential verified',
    description: 'The chain confirmed the on-chain credential, the proof hash is now trusted.',
    keywords: ['sepolia', 'blockchain', 'on-chain', 'chain', 'confirm', 'trust', 'proof', 'hash'],
    trigger:
      'Fires when the Sepolia transaction carrying this credential is finalised. Safe to trust the proof hash on-chain from this moment on.',
    samplePayload: {
      id: 'cr_9f8e7d6c',
      userRef: 'usr_9f8e7d6c',
      level: 'basic',
      proofHash: 'sha256:…',
      chainContractId: '0x91f4…',
      chainNetwork: 'sepolia',
      verifiedAt: '2026-04-19T10:24:47Z',
    },
  },
  'credential.revoked': {
    label: 'Credential revoked',
    description: 'Credential was revoked (self-service or admin). Clear any cached verified state.',
    keywords: ['revoke', 'cancel', 'invalidate', 'remove', 'delete', 'ban', 'disable'],
    trigger:
      'Fires when the on-chain `RevokeCredential` choice is exercised — from customer self-service, admin action, fraud workflow, or a compliance escalation.',
    samplePayload: {
      id: 'cr_9f8e7d6c',
      userRef: 'usr_9f8e7d6c',
      previousLevel: 'enhanced',
      reason: 'customer_requested',
      revokedAt: '2026-05-02T09:12:00Z',
    },
  },
  'credential.expired': {
    label: 'Credential expired',
    description: 'Credential passed its validity window. Prompt the user to re-verify.',
    keywords: ['expire', 'expired', 'timeout', 'ttl', 'stale', 're-verify', 'aging'],
    trigger:
      'Fires when the scheduled expiry worker observes that `validUntil` has passed and flips the credential to `expired` on-chain.',
    samplePayload: {
      id: 'cr_9f8e7d6c',
      userRef: 'usr_9f8e7d6c',
      level: 'enhanced',
      validUntil: '2027-04-19T00:00:00Z',
      expiredAt: '2027-04-19T00:00:01Z',
    },
  },
  'credential.updated': {
    label: 'Credential updated',
    description: 'Metadata on an existing credential changed (e.g. upgrade in progress).',
    keywords: ['update', 'change', 'modify', 'metadata', 'edit'],
    trigger:
      'Fires when a non-revoking, non-upgrading metadata change lands — for example a mid-flight level change request, score refresh, or validator rotation note.',
    samplePayload: {
      id: 'cr_9f8e7d6c',
      userRef: 'usr_9f8e7d6c',
      changedFields: ['humanScore'],
      humanScore: 92,
      updatedAt: '2026-06-10T14:03:00Z',
    },
  },
  'credential.upgraded': {
    label: 'Credential upgraded',
    description: 'Customer reached a higher KYC level — basic → enhanced.',
    keywords: ['upgrade', 'level', 'tier', 'basic', 'enhanced', 'promote', 'kyc level'],
    trigger:
      'Fires when the customer finishes the additional phase(s) that move them to a higher level — e.g. address workflow approved on top of an existing basic credential.',
    samplePayload: {
      id: 'cr_9f8e7d6c',
      userRef: 'usr_9f8e7d6c',
      previousLevel: 'basic',
      newLevel: 'enhanced',
      newScore: 87,
      upgradedAt: '2026-06-21T08:45:00Z',
    },
  },
  'kyc.session.created': {
    label: 'KYC session started',
    description: 'A new verification session was opened for the customer.',
    keywords: ['start', 'begin', 'open', 'new', 'session', 'verify', 'verification', 'didit'],
    trigger:
      'Fires when a firm or the customer opens a Didit session via `/api/v1/sessions` or the OAuth flow. Carries the redirect URL you can hand back to the user.',
    samplePayload: {
      id: 'ks_1a2b3c',
      userRef: 'usr_9f8e7d6c',
      workflow: 'identity',
      level: 'basic',
      verificationUrl: 'https://verification.didit.me/session/…',
      expiresAt: '2026-04-20T10:24:11Z',
      createdAt: '2026-04-19T10:24:11Z',
    },
  },
  'kyc.session.approved': {
    label: 'KYC session approved',
    description: 'The upstream KYC provider approved the session. Credential issuance follows.',
    keywords: ['approve', 'approved', 'pass', 'success', 'ok', 'accept', 'didit', 'verified'],
    trigger:
      'Fires when Didit returns an `Approved` decision on the terminal phase for the requested level. For `basic` the terminal is the identity workflow; for `enhanced` it is the address workflow.',
    samplePayload: {
      id: 'ks_1a2b3c',
      userRef: 'usr_9f8e7d6c',
      level: 'enhanced',
      approvedAt: '2026-04-19T10:31:18Z',
    },
  },
  'kyc.session.rejected': {
    label: 'KYC session rejected',
    description: 'The upstream KYC provider rejected the session.',
    keywords: ['reject', 'rejected', 'fail', 'failed', 'decline', 'denied', 'didit'],
    trigger:
      'Fires when Didit returns a `Declined` decision. The customer-facing reason is intentionally generic; raw Didit signals stay on Crivacy for fraud analysis.',
    samplePayload: {
      id: 'ks_1a2b3c',
      userRef: 'usr_9f8e7d6c',
      reason: 'identity_mismatch',
      rejectedAt: '2026-04-19T10:31:18Z',
    },
  },
  'kyc.session.in_review': {
    label: 'KYC session under review',
    description:
      'Compliance flagged the session for manual review (typically 24-48h SLA). No user action needed — wait for the next event.',
    keywords: ['review', 'manual', 'compliance', 'pending', 'wait', 'flag', 'didit'],
    trigger:
      'Fires when Didit returns an `In Review` decision — compliance is reviewing flagged signals on the session. The next terminal event will be `kyc.session.approved`, `kyc.session.rejected`, or `kyc.session.resubmission_required`.',
    samplePayload: {
      id: 'ks_1a2b3c',
      userRef: 'usr_9f8e7d6c',
      workflow: 'identity',
      inReviewAt: '2026-04-19T10:31:18Z',
    },
  },
  'kyc.session.resubmission_required': {
    label: 'KYC session needs resubmission',
    description:
      'Compliance asked the user to redo specific verification steps. Surface a "redo" prompt and the resume URL on your side.',
    keywords: ['resubmit', 'resubmission', 'redo', 'retry', 'fix', 'compliance', 'didit'],
    trigger:
      'Fires when Didit returns a `Resubmitted` decision listing the specific feature nodes (OCR, LIVENESS, FACE_MATCH, POA, …) the user must redo. The same Didit session resumes from its original verification URL — only the flagged steps are repeated.',
    samplePayload: {
      id: 'ks_1a2b3c',
      userRef: 'usr_9f8e7d6c',
      workflow: 'identity',
      nodesToResubmit: [
        { feature: 'OCR', reason: 'Document photo unclear' },
        { feature: 'LIVENESS', reason: 'Face not detected' },
      ],
      resumeUrl: 'https://verification.didit.me/session/…',
      requestedAt: '2026-04-19T10:31:18Z',
    },
  },
  'kyc.session.kyc_expired': {
    label: 'KYC credential expired',
    description:
      'A previously-approved verification crossed the Didit expiration policy and the on-chain credential was revoked. Drop cached verified state.',
    keywords: ['expire', 'expired', 'kyc', 'credential', 'revoke', 'aging', 'reverify', 'didit'],
    trigger:
      'Fires when Didit returns a `Kyc Expired` decision on a previously-approved session. The on-chain `RevokeCredential` choice is exercised in parallel, so subscribers also receive `credential.revoked`. Subscribe to either or both depending on whether you key off session lifecycle or credential lifecycle.',
    samplePayload: {
      id: 'ks_1a2b3c',
      userRef: 'usr_9f8e7d6c',
      workflow: 'identity',
      expiredAt: '2027-04-19T10:31:18Z',
    },
  },
  'oauth.consent.granted': {
    label: 'OAuth consent granted',
    description: 'The customer approved your client on the Crivacy consent screen.',
    keywords: ['login', 'sign in', 'connect', 'authorize', 'oauth', 'grant', 'approve', 'link'],
    trigger:
      'Fires on the first consent for a given `(user, client, scope)` tuple. Re-authorizations that hit the consent cache do NOT fire this event.',
    samplePayload: {
      id: 'oc_8h7g6f',
      clientId: 'cli_…',
      userId: 'usr_9f8e7d6c',
      scope: 'openid kyc:read',
      grantedAt: '2026-04-19T10:32:02Z',
    },
  },
  'oauth.consent.revoked': {
    label: 'OAuth consent revoked',
    description:
      'The customer revoked your client from their Connected Apps page. Drop cached tokens.',
    keywords: ['disconnect', 'unlink', 'logout', 'oauth', 'revoke', 'remove', 'uninstall'],
    trigger:
      'Fires when the customer removes your client from their Connected Apps list. All access tokens minted under the revoked consent are server-invalidated at the same time.',
    samplePayload: {
      id: 'oc_8h7g6f',
      clientId: 'cli_…',
      userId: 'usr_9f8e7d6c',
      revokedAt: '2026-05-14T17:50:11Z',
    },
  },
} as const satisfies Record<
  WebhookEvent,
  {
    readonly label: string;
    readonly description: string;
    readonly keywords: readonly string[];
    readonly trigger: string;
    readonly samplePayload: Readonly<Record<string, unknown>>;
  }
>;
