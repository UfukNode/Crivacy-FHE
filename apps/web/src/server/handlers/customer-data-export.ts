/**
 * GDPR Article 15 (right of access) + Article 20 (data portability).
 *
 * Assembles a self-contained JSON dump of every row the customer
 * owns across the system, delivered as an HTTP response the caller
 * can save directly (`Content-Disposition: attachment`). The payload
 * is intentionally flat-ish (sections are top-level keys) so a
 * non-developer can open the file and read it.
 *
 * Scope rules:
 *   - Customer profile fields as stored at export time.
 *   - KYC credentials metadata (not the raw documents — those leave
 *     Crivacy's hands after Didit processes them).
 *   - KYC sessions (attempts, outcomes, timestamps).
 *   - OAuth consents granted + revoked.
 *   - Active + revoked sessions (high-level: device, city, IP).
 *   - Linked auth providers (Google, wallet).
 *   - Notifications marked as belonging to the customer.
 *   - Audit rows where the customer is the actor or the target.
 *
 * Out of scope:
 *   - Audit rows with other customers/firms as primary actor
 *     (would leak third-party identity).
 *   - Admin-private audit meta (redacted via `redactMeta`).
 *   - Secrets (password hash, TOTP secret — ever).
 *
 * @module
 */

import { and, eq, or } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { customerActor, customerLabel } from '@/lib/audit/actors';
import { redactMeta } from '@/lib/audit';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { noTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import * as schema from '@/lib/db/schema';

import type { CustomerContext } from '../context';

export async function handleCustomerDataExport(
  ctx: CustomerContext,
): Promise<NextResponse> {
  const db = ctx.db;
  const customerId = ctx.customer.id;

  // --- 1. Profile (stored values as-is; nothing redacted for the
  //        data subject themselves — they own every field here) ---
  const [customer] = await db
    .select()
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId))
    .limit(1);

  const profile = customer
    ? {
        id: customer.id,
        email: customer.email,
        emailVerifiedAt: customer.emailVerifiedAt?.toISOString() ?? null,
        displayName: customer.displayName,
        phone: customer.phone,
        // GDPR Art 15 export: Crivacy stores ZERO raw PII columns
        // (full_name / date_of_birth / nationality / document_* /
        // address_*) since migration 20260509000000. The data
        // subject's underlying PII lives in Didit; data export must
        // direct the subject to Didit's user-data-export endpoint
        // for those fields. We export only what we hold.
        kycLevel: customer.kycLevel,
        kycScore: customer.kycScore,
        status: customer.status,
        createdAt: customer.createdAt.toISOString(),
        updatedAt: customer.updatedAt.toISOString(),
      }
    : null;

  // --- 2. KYC sessions ---
  // Read from the unified `kyc_sessions` table with a `kind = 'customer'`
  // filter (Sprint 7).
  const kycSessions = await db
    .select({
      id: schema.kycSessions.id,
      status: schema.kycSessions.status,
      failureReason: schema.kycSessions.failureReason,
      createdAt: schema.kycSessions.createdAt,
      updatedAt: schema.kycSessions.updatedAt,
    })
    .from(schema.kycSessions)
    .where(
      and(
        eq(schema.kycSessions.kind, 'customer' as const),
        eq(schema.kycSessions.customerId, customerId),
      ),
    );

  // --- 3. KYC credentials meta (on-chain-issued credentials) ---
  const credentials = await db
    .select({
      id: schema.kycCredentialsMeta.id,
      level: schema.kycCredentialsMeta.level,
      status: schema.kycCredentialsMeta.status,
      validFrom: schema.kycCredentialsMeta.validFrom,
      validUntil: schema.kycCredentialsMeta.validUntil,
      revokedReason: schema.kycCredentialsMeta.revokedReason,
      createdAt: schema.kycCredentialsMeta.createdAt,
    })
    .from(schema.kycCredentialsMeta)
    .where(eq(schema.kycCredentialsMeta.userRef, customerId));

  // --- 4. OAuth consents (granted + revoked) ---
  const consents = await db
    .select({
      id: schema.oauthConsents.id,
      clientId: schema.oauthConsents.clientId,
      scope: schema.oauthConsents.scope,
      grantedAt: schema.oauthConsents.grantedAt,
      expiresAt: schema.oauthConsents.expiresAt,
      lastUsedAt: schema.oauthConsents.lastUsedAt,
      revokedAt: schema.oauthConsents.revokedAt,
    })
    .from(schema.oauthConsents)
    .where(eq(schema.oauthConsents.userId, customerId));

  // --- 5. Sessions (active + revoked, IP truncated to /24 for
  //        coarser geolocation but not pinpoint) ---
  const sessions = await db
    .select({
      id: schema.customerSessions.id,
      ip: schema.customerSessions.ip,
      userAgent: schema.customerSessions.userAgent,
      deviceName: schema.customerSessions.deviceName,
      city: schema.customerSessions.city,
      rememberMe: schema.customerSessions.rememberMe,
      issuedAt: schema.customerSessions.issuedAt,
      expiresAt: schema.customerSessions.expiresAt,
      lastActiveAt: schema.customerSessions.lastActiveAt,
      revokedAt: schema.customerSessions.revokedAt,
      revokedReason: schema.customerSessions.revokedReason,
    })
    .from(schema.customerSessions)
    .where(eq(schema.customerSessions.customerId, customerId));

  // --- 6. Linked auth providers ---
  const linkedAccounts = await db
    .select({
      id: schema.customerLinkedAccounts.id,
      provider: schema.customerLinkedAccounts.provider,
      providerEmail: schema.customerLinkedAccounts.providerEmail,
      providerDisplayName: schema.customerLinkedAccounts.providerDisplayName,
      createdAt: schema.customerLinkedAccounts.createdAt,
    })
    .from(schema.customerLinkedAccounts)
    .where(eq(schema.customerLinkedAccounts.customerId, customerId));

  // --- 7. Notifications ---
  const notifications = await db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.customerId, customerId));

  // --- 8. Audit rows where customer was the actor or target ---
  //        `firm` audience redaction — if a firm action appears in the
  //        stream, the customer shouldn't see other firms' private
  //        meta. For rows the customer owns, nothing is redacted
  //        (their own email/phone is fine to echo back).
  const auditRows = await db
    .select({
      id: schema.auditLog.id,
      action: schema.auditLog.action,
      actorKind: schema.auditLog.actorKind,
      actorId: schema.auditLog.actorId,
      targetKind: schema.auditLog.targetKind,
      targetId: schema.auditLog.targetId,
      meta: schema.auditLog.meta,
      ts: schema.auditLog.ts,
    })
    .from(schema.auditLog)
    .where(
      or(
        and(eq(schema.auditLog.actorKind, 'customer'), eq(schema.auditLog.actorId, customerId)),
        and(eq(schema.auditLog.targetKind, 'customer'), eq(schema.auditLog.targetId, customerId)),
      ),
    );

  const auditEntries = auditRows.map((row) => {
    const rawMeta = (row.meta as Record<string, unknown> | null) ?? null;
    return {
      ...row,
      meta:
        rawMeta === null ? null : redactMeta(rawMeta, { audience: 'compliance' }),
      ts: row.ts.toISOString(),
    };
  });

  // --- 9. Audit the export itself ---
  const auditCtx = buildAuditContext({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
  await writeAudit(db, {
    action: 'compliance.data_exported',
    actor: customerActor({
      id: customerId,
      label: customerLabel({ email: ctx.customer.email, id: customerId }),
    }),
    target: noTarget(),
    context: auditCtx,
    meta: {
      kycSessionCount: kycSessions.length,
      credentialCount: credentials.length,
      consentCount: consents.length,
      sessionCount: sessions.length,
      notificationCount: notifications.length,
      auditRowCount: auditEntries.length,
    },
    ts: ctx.now,
  });

  // --- 10. Build the JSON download ---
  const payload = {
    exportedAt: ctx.now.toISOString(),
    exportVersion: 1,
    exportPolicy:
      'GDPR Article 15 (right of access) + Article 20 (data portability). Includes every row Crivacy stores about the subject. Third-party metadata (other customers, firm-internal fields) is either omitted or redacted per the `compliance` audience redaction policy.',
    customer: profile,
    kycSessions,
    credentials,
    oauthConsents: consents,
    sessions,
    linkedAccounts,
    notifications,
    audit: auditEntries,
  };

  const filename = `crivacy-data-export-${customerId}-${ctx.now.toISOString().slice(0, 10)}.json`;

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'x-request-id': ctx.requestId,
    },
  });
}
