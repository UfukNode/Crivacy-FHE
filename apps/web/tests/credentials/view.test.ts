// @vitest-environment node
/**
 * Canonical credential view + adapter tests.
 *
 * Pins the byte-level wire shape of every adapter so a refactor of
 * callers (OAuth claims, webhook payloads, REST surfaces) can never
 * silently drift. The OAuth invariants here are a strict superset of
 * `tests/oauth/claims.test.ts`'s — that file remains as a regression
 * pin once `lib/oauth/claims.ts` migrates to call `toOauthClaims`.
 */

import { describe, expect, it } from 'vitest';

import {
  type CredentialView,
  type KycSessionView,
  fromKycCredentialMetaRow,
  toOauthClaims,
  toWebhookPayload,
  toRestDetail,
  toRestSummary,
  toSessionWebhookPayload,
} from '@/lib/credentials/view';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_BLOB = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33]);
const FIXTURE_BLOB_BASE64URL = Buffer.from(FIXTURE_BLOB).toString('base64url');

const fixtureView: CredentialView = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  firmId: '22222222-2222-4222-8222-222222222222',
  userRef: 'user-ref-abc',
  contractId: '00abc:42',
  level: 'enhanced',
  status: 'active',
  identityVerified: true,
  livenessVerified: true,
  addressVerified: false,
  humanScore: 87,
  proofHash: ('0xdeadbeef' as string).padEnd(66, '0'),
  validator: 'didit',
  network: 'mainnet',
  validFrom: new Date('2026-05-01T00:00:00.000Z'),
  validUntil: new Date('2027-05-01T00:00:00.000Z'),
  confirmedAt: new Date('2026-05-01T00:30:00.000Z'),
  revokedAt: null,
  revokedReason: null,
  expiredAt: null,
  disclosureBlob: FIXTURE_BLOB,
  operatorParty: 'Crivacy::1220abcd',
  userParty: 'User::1220ef01',
  templateId: 'crivacy-kyc:Crivacy.KYCCredential:KYCCredential',
  updatedAt: new Date('2026-05-01T00:30:00.000Z'),
});

const userId = 'u1111111-1111-4111-8111-111111111111';

// ---------------------------------------------------------------------------
// fromKycCredentialMetaRow
// ---------------------------------------------------------------------------

describe('fromKycCredentialMetaRow', () => {
  it('projects DB integers (0/1) to booleans for verified flags', () => {
    // Mimic the on-disk shape — integer flags, snake-cased chain fields.
    const row = {
      id: fixtureView.id,
      firmId: fixtureView.firmId,
      userRef: fixtureView.userRef,
      kycSessionId: null,
      chainContractId: fixtureView.contractId,
      chainPackageName: 'crivacy-kyc',
      chainTemplateId: fixtureView.templateId,
      chainNetwork: 'mainnet' as const,
      operatorParty: fixtureView.operatorParty,
      userParty: fixtureView.userParty,
      level: fixtureView.level,
      status: fixtureView.status,
      validator: fixtureView.validator,
      proofHash: fixtureView.proofHash,
      proofSchemaId: '33333333-3333-4333-8333-333333333333',
      humanScore: fixtureView.humanScore,
      identityVerified: 1,
      livenessVerified: 1,
      addressVerified: 0,
      validFrom: fixtureView.validFrom,
      validUntil: fixtureView.validUntil,
      confirmedAt: fixtureView.confirmedAt,
      revokedAt: null,
      revokedReason: null,
      expiredAt: null,
      disclosureBlobCache: FIXTURE_BLOB,
      disclosureBlobFetchedAt: new Date('2026-05-01T00:30:00.000Z'),
      supersededBy: null,
      chainSubmissionId: null,
      chainUpdateId: null,
      nftContractId: null,
      nftMintedAt: null,
      nftBurnedAt: null,
      nftChainUpdateId: null,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: fixtureView.updatedAt,
    };

    const projected = fromKycCredentialMetaRow(row);

    expect(projected.identityVerified).toBe(true);
    expect(projected.livenessVerified).toBe(true);
    expect(projected.addressVerified).toBe(false);
    expect(projected.contractId).toBe(fixtureView.contractId);
    expect(projected.network).toBe('mainnet');
    expect(projected.templateId).toBe(fixtureView.templateId);
    expect(projected.disclosureBlob).toBe(FIXTURE_BLOB);
  });

  it('projects nullable lifecycle fields without coercion', () => {
    const row = {
      id: fixtureView.id,
      firmId: fixtureView.firmId,
      userRef: fixtureView.userRef,
      kycSessionId: null,
      chainContractId: null,
      chainPackageName: 'crivacy-kyc',
      chainTemplateId: fixtureView.templateId,
      chainNetwork: 'mainnet' as const,
      operatorParty: fixtureView.operatorParty,
      userParty: fixtureView.userParty,
      level: 'basic' as const,
      status: 'pending' as const,
      validator: 'didit' as const,
      proofHash: fixtureView.proofHash,
      proofSchemaId: '33333333-3333-4333-8333-333333333333',
      humanScore: 0,
      identityVerified: 0,
      livenessVerified: 0,
      addressVerified: 0,
      validFrom: fixtureView.validFrom,
      validUntil: fixtureView.validUntil,
      confirmedAt: null,
      revokedAt: null,
      revokedReason: null,
      expiredAt: null,
      disclosureBlobCache: null,
      disclosureBlobFetchedAt: null,
      supersededBy: null,
      chainSubmissionId: null,
      chainUpdateId: null,
      nftContractId: null,
      nftMintedAt: null,
      nftBurnedAt: null,
      nftChainUpdateId: null,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: fixtureView.updatedAt,
    };

    const projected = fromKycCredentialMetaRow(row);

    expect(projected.contractId).toBeNull();
    expect(projected.confirmedAt).toBeNull();
    expect(projected.revokedAt).toBeNull();
    expect(projected.expiredAt).toBeNull();
    expect(projected.disclosureBlob).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toOauthClaims — superset of legacy oauth/claims.test.ts pins
// ---------------------------------------------------------------------------

describe('toOauthClaims — openid', () => {
  it('emits sub only when openid is in scope', () => {
    const withOpenid = toOauthClaims({ userId, view: null, scopes: ['openid'] });
    expect(withOpenid.sub).toBe(userId);

    const withoutOpenid = toOauthClaims({ userId, view: fixtureView, scopes: ['kyc'] });
    expect(withoutOpenid.sub).toBeUndefined();
  });
});

describe('toOauthClaims — kyc', () => {
  it('emits identity + liveness, not address or score', () => {
    const c = toOauthClaims({ userId, view: fixtureView, scopes: ['kyc'] });
    expect(c.identity_verified).toBe(true);
    expect(c.liveness_verified).toBe(true);
    expect(c.address_verified).toBeUndefined();
    expect(c.humanity_score).toBeUndefined();
    expect(c.credential_proof_hash).toBeUndefined();
  });

  it('skips kyc claims when no credential is available', () => {
    const c = toOauthClaims({ userId, view: null, scopes: ['openid', 'kyc'] });
    expect(c.sub).toBe(userId);
    expect(c.identity_verified).toBeUndefined();
  });
});

describe('toOauthClaims — kyc:address', () => {
  it('emits address_verified only when kyc:address is in scope', () => {
    const withScope = toOauthClaims({
      userId,
      view: fixtureView,
      scopes: ['kyc:address'],
    });
    expect(withScope.address_verified).toBe(false);

    const withoutScope = toOauthClaims({
      userId,
      view: fixtureView,
      scopes: ['kyc'],
    });
    expect(withoutScope.address_verified).toBeUndefined();
  });
});

describe('toOauthClaims — kyc:scores', () => {
  it('emits humanity_score as the numeric score when in scope', () => {
    const c = toOauthClaims({
      userId,
      view: fixtureView,
      scopes: ['kyc:scores'],
    });
    expect(c.humanity_score).toBe(87);
  });
});

describe('toOauthClaims — credential', () => {
  it('emits the full chain reference set when in scope', () => {
    const c = toOauthClaims({
      userId,
      view: fixtureView,
      scopes: ['credential'],
    });
    expect(c.credential_proof_hash).toBe(fixtureView.proofHash);
    expect(c.credential_level).toBe('enhanced');
    expect(c.credential_valid_until).toBe('2027-05-01T00:00:00.000Z');
    expect(c.credential_network).toBe('mainnet');
    expect(c.credential_contract_id).toBe(fixtureView.contractId);
  });

  it('emits null contract id literally (pre-confirmation case)', () => {
    const c = toOauthClaims({
      userId,
      view: { ...fixtureView, contractId: null },
      scopes: ['credential'],
    });
    expect(c.credential_contract_id).toBeNull();
  });

  it('does NOT emit chain claims outside credential scope', () => {
    const c = toOauthClaims({
      userId,
      view: fixtureView,
      scopes: ['openid', 'kyc'],
    });
    expect(c.credential_proof_hash).toBeUndefined();
    expect(c.credential_level).toBeUndefined();
    expect(c.credential_credential_blob).toBeUndefined();
  });

  it('emits credential_credential_blob as base64url when blob is cached and scope granted', () => {
    const c = toOauthClaims({
      userId,
      view: fixtureView,
      scopes: ['credential'],
    });
    expect(c.credential_credential_blob).toBe(FIXTURE_BLOB_BASE64URL);
  });

  it('omits credential_credential_blob when blob is null even if scope granted', () => {
    const c = toOauthClaims({
      userId,
      view: { ...fixtureView, disclosureBlob: null },
      scopes: ['credential'],
    });
    expect(c.credential_credential_blob).toBeUndefined();
  });
});

describe('toOauthClaims — scope independence', () => {
  it('every scope requested is reflected in the output — no silent drops', () => {
    const c = toOauthClaims({
      userId,
      view: fixtureView,
      scopes: ['openid', 'kyc', 'kyc:address', 'kyc:scores', 'credential'],
    });
    expect(c.sub).toBe(userId);
    expect(c.identity_verified).toBe(true);
    expect(c.liveness_verified).toBe(true);
    expect(c.address_verified).toBe(false);
    expect(c.humanity_score).toBe(87);
    expect(c.credential_proof_hash).toBe(fixtureView.proofHash);
    expect(c.credential_credential_blob).toBe(FIXTURE_BLOB_BASE64URL);
  });

  it('empty scope set → empty claim set', () => {
    const c = toOauthClaims({ userId, view: fixtureView, scopes: [] });
    expect(Object.keys(c)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// toWebhookPayload — single canonical webhook envelope payload
// ---------------------------------------------------------------------------

describe('toWebhookPayload', () => {
  it('emits camelCase full set with blob inline (base64url)', () => {
    const p = toWebhookPayload(fixtureView);

    expect(p).toEqual({
      credentialId: fixtureView.id,
      contractId: fixtureView.contractId,
      userRef: fixtureView.userRef,
      level: 'enhanced',
      status: 'active',
      identityVerified: true,
      livenessVerified: true,
      addressVerified: false,
      humanScore: 87,
      proofHash: fixtureView.proofHash,
      validator: 'didit',
      network: 'mainnet',
      validFrom: '2026-05-01T00:00:00.000Z',
      validUntil: '2027-05-01T00:00:00.000Z',
      confirmedAt: '2026-05-01T00:30:00.000Z',
      revokedAt: null,
      revokedReason: null,
      expiredAt: null,
      disclosureBlob: FIXTURE_BLOB_BASE64URL,
      updatedAt: '2026-05-01T00:30:00.000Z',
    });
  });

  it('keeps blob as null (not empty string) when missing', () => {
    const p = toWebhookPayload({ ...fixtureView, disclosureBlob: null });
    expect(p.disclosureBlob).toBeNull();
  });

  it('serialises lifecycle dates as ISO when set, null when absent', () => {
    const revokedView: CredentialView = {
      ...fixtureView,
      status: 'revoked',
      revokedAt: new Date('2026-06-15T12:00:00.000Z'),
      revokedReason: 'didit_user_blocked',
    };
    const p = toWebhookPayload(revokedView);
    expect(p.revokedAt).toBe('2026-06-15T12:00:00.000Z');
    expect(p.revokedReason).toBe('didit_user_blocked');
    expect(p.status).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
// toRestSummary / toRestDetail — REST GET wire shapes
// ---------------------------------------------------------------------------

describe('toRestSummary', () => {
  it('matches the legacy credentialToSummary shape', () => {
    const s = toRestSummary(fixtureView);
    expect(s).toEqual({
      contractId: fixtureView.contractId,
      firmId: fixtureView.firmId,
      userRef: fixtureView.userRef,
      status: 'active',
      level: 'enhanced',
      validUntil: '2027-05-01T00:00:00.000Z',
      identityVerified: true,
      livenessVerified: true,
      addressVerified: false,
      network: 'mainnet',
      updatedAt: '2026-05-01T00:30:00.000Z',
    });
  });

  it('coalesces null contractId to empty string (legacy compat)', () => {
    const s = toRestSummary({ ...fixtureView, contractId: null });
    expect(s.contractId).toBe('');
  });
});

describe('toRestDetail', () => {
  it('matches the legacy credentialToDetail shape (validator mapped to PascalCase)', () => {
    const d = toRestDetail(fixtureView);
    expect(d.contractId).toBe(fixtureView.contractId);
    expect(d.proofHash).toBe(fixtureView.proofHash);
    expect(d.validator).toBe('DiditValidator');
    expect(d.operatorParty).toBe(fixtureView.operatorParty);
    expect(d.templateId).toBe(fixtureView.templateId);
    expect(d.humanScore).toBe(87);
    expect(d.issuedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(d.disclosureBlob).toBe(FIXTURE_BLOB_BASE64URL);
    expect(d.revokedAt).toBeNull();
    expect(d.revocationReason).toBeNull();
  });

  it('emits empty string disclosureBlob (legacy compat) when blob missing', () => {
    const d = toRestDetail({ ...fixtureView, disclosureBlob: null });
    expect(d.disclosureBlob).toBe('');
  });

  it('maps Chain + ZK validators to PascalCase', () => {
    const chainD = toRestDetail({ ...fixtureView, validator: 'chain' });
    expect(chainD.validator).toBe('ChainValidator');

    const zkD = toRestDetail({ ...fixtureView, validator: 'zk' });
    expect(zkD.validator).toBe('ZKValidator');
  });

  it('surfaces revocation lifecycle when set', () => {
    const d = toRestDetail({
      ...fixtureView,
      status: 'revoked',
      revokedAt: new Date('2026-06-15T12:00:00.000Z'),
      revokedReason: 'customer_banned',
    });
    expect(d.revokedAt).toBe('2026-06-15T12:00:00.000Z');
    expect(d.revocationReason).toBe('customer_banned');
  });
});

// ---------------------------------------------------------------------------
// toSessionWebhookPayload — pre-credential session events
// ---------------------------------------------------------------------------

describe('toSessionWebhookPayload', () => {
  it('emits camelCase session metadata with ISO timestamps', () => {
    const sessionView: KycSessionView = {
      sessionId: '44444444-4444-4444-8444-444444444444',
      userRef: 'firm-user-9',
      workflow: 'identity',
      level: 'basic',
      verificationUrl: 'https://didit.test/verify/abc',
      expiresAt: new Date('2026-05-08T15:00:00.000Z'),
      createdAt: new Date('2026-05-08T14:00:00.000Z'),
    };

    const p = toSessionWebhookPayload(sessionView);

    expect(p).toEqual({
      sessionId: sessionView.sessionId,
      userRef: 'firm-user-9',
      workflow: 'identity',
      level: 'basic',
      verificationUrl: 'https://didit.test/verify/abc',
      expiresAt: '2026-05-08T15:00:00.000Z',
      createdAt: '2026-05-08T14:00:00.000Z',
    });
  });

  it('keeps verificationUrl + expiresAt nullable on the wire', () => {
    const sessionView: KycSessionView = {
      sessionId: '44444444-4444-4444-8444-444444444444',
      userRef: 'firm-user-9',
      workflow: 'address',
      level: 'enhanced',
      verificationUrl: null,
      expiresAt: null,
      createdAt: new Date('2026-05-08T14:00:00.000Z'),
    };

    const p = toSessionWebhookPayload(sessionView);
    expect(p.verificationUrl).toBeNull();
    expect(p.expiresAt).toBeNull();
  });
});
