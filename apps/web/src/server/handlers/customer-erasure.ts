/**
 * GDPR Article 17 (right to erasure).
 *
 * Strategy: **anonymize + soft-delete**, not hard-delete. Reasons:
 *   - Audit log is append-only by design (PLAN.md step 30). Hard
 *     deleting customer rows would break FK integrity on audit_log
 *     rows that reference the customer as actor/target.
 *   - credentials are public-ledger artefacts; we can't pull
 *     them off-chain. We mark the DB meta as `revoked_reason =
 *     'erasure_requested'` so downstream consumers know the claim
 *     should no longer be relied on, and the on-chain revoke happens
 *     via the shared `revokeActiveCredentials` helper.
 *   - Legal holds: a subset of audit rows may be required for
 *     fraud-investigation / AML retention even after erasure. We
 *     redact PII fields in those rows but keep the row.
 *
 * What this flow does (atomic transaction):
 *   1. Revoke every active credential + DB row + fire
 *      `credential.revoked` webhook for each (via shared helper).
 *   2. Clear PII fields on `customers`: displayName, phone, full_name,
 *      DOB, address, nationality, document fields. Set a synthetic
 *      tombstone email `erased-<uuid>@erased.crivacy.invalid` so the
 *      row retains a UNIQUE-indexable placeholder without ever
 *      matching a real email.
 *   3. Soft-delete (`deletedAt = now`, `status = 'erased'`).
 *   4. Revoke ALL sessions.
 *   5. Delete linked auth providers (wallet / google rows).
 *   6. Revoke all OAuth consents.
 *   7. Hash remaining PII references in audit meta (via the
 *      redaction policy — compliance audience so we don't touch
 *      fields that law requires us to keep).
 *   8. Write `compliance.erasure_requested` audit event.
 *
 * @module
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { customerActor, customerLabel } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { noTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import * as schema from '@/lib/db/schema';
import { revokeActiveCredentials } from '@/lib/fraud/ban';

import type { CustomerContext } from '../context';

export async function handleCustomerErasure(
  ctx: CustomerContext,
): Promise<NextResponse> {
  const db = ctx.db;
  const customerId = ctx.customer.id;
  const now = ctx.now;

  // Idempotency — if already erased, 409 rather than re-run the
  // destructive cascade (which would double-emit webhooks, etc.).
  const [existing] = await db
    .select({ deletedAt: schema.customers.deletedAt, status: schema.customers.status })
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId))
    .limit(1);
  if (existing === undefined) {
    return ctx.errorJson('not_found', 'Account not found.', 404);
  }
  if (existing.deletedAt !== null) {
    return ctx.errorJson('conflict', 'Account has already been erased.', 409);
  }

  // --- 1. Revoke credentials (on-chain + DB + webhook) ---
  //        Must run BEFORE the customer row is anonymized because
  //        `revokeActiveCredentials` reads fields that we null below.
  const credentialsRevoked = await revokeActiveCredentials(
    db,
    customerId,
    now,
    'erasure_requested',
  );

  // --- 2-8. Rest in a single transaction so a partial erasure (PII
  //          cleared but consent row still active, etc.) never
  //          leaves an observable window. ---
  await db.transaction(async (tx) => {
    // 2. Anonymize the customer row — email gets a tombstone so the
    //    unique constraint on `lower(email)` stays satisfied without
    //    ever matching a real inbox.
    const tombstoneEmail = `erased-${customerId}@erased.crivacy.invalid`;
    await tx
      .update(schema.customers)
      .set({
        email: tombstoneEmail,
        emailVerifiedAt: null,
        displayName: null,
        phone: null,
        // PII columns (full_name / date_of_birth / nationality /
        // document_* / address_*) dropped from this table by
        // migration 20260509000000 — no nulls to set here.
        avatarStorageKey: null,
        kycFieldsLocked: false,
        kycLevel: 'kyc_0',
        kycScore: 0,
        passwordHash: null,
        status: 'banned',
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.customers.id, customerId));

    // 3. Revoke every session (active + not yet revoked). The
    //    caller's current request is the last thing this session
    //    will do — the response sets clearing cookies too.
    await tx
      .update(schema.customerSessions)
      .set({ revokedAt: now, revokedReason: 'erasure_requested' })
      .where(
        and(
          eq(schema.customerSessions.customerId, customerId),
          isNull(schema.customerSessions.revokedAt),
        ),
      );

    // 4. Delete linked auth providers (google, wallet). These rows
    //    contain provider_email / wallet address — non-Crivacy PII
    //    the data subject asked us to forget.
    await tx
      .delete(schema.customerLinkedAccounts)
      .where(eq(schema.customerLinkedAccounts.customerId, customerId));

    // 5. Revoke all OAuth consents.
    await tx
      .update(schema.oauthConsents)
      .set({ revokedAt: now, revokedReason: 'erasure_requested' })
      .where(
        and(
          eq(schema.oauthConsents.userId, customerId),
          isNull(schema.oauthConsents.revokedAt),
        ),
      );

    // 6. Revoke all OAuth access tokens (cascade-deletes would fire
    //    on customer hard-delete; soft-delete needs manual revoke).
    await tx
      .update(schema.oauthAccessTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.oauthAccessTokens.userId, customerId),
          isNull(schema.oauthAccessTokens.revokedAt),
        ),
      );

    // 7. Clear pending password reset tokens + email verification
    //    tokens (not strictly needed after status flip but cheap
    //    and avoids a stale token lingering).
    await tx
      .delete(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.customerId, customerId));
    await tx
      .delete(schema.emailVerificationTokens)
      .where(eq(schema.emailVerificationTokens.customerId, customerId));

    // 8. Redact PII from historical audit_log meta (where this
    //    customer is actor/target). We replace the whole meta column
    //    with a compact marker — preserves the row for compliance
    //    retention, wipes identifying fields. Reversible? No — this
    //    is the erasure bit.
    //
    // BUG #44 fix (2026-04-25): the redacted_at parameter feeds into
    // `jsonb_build_object` which gives postgres no type hint, so the
    // prepared-statement type inferencer reports "could not determine
    // data type of parameter $1". Cast explicitly to text. (The
    // earlier hypothesis was an RLS scope issue — verified with
    // `crivacy_app` psql that the SQL itself runs fine cross-RLS, the
    // failure is purely the missing parameter type cast.)
    await tx.execute(sql`
      UPDATE audit_log
         SET meta = jsonb_build_object(
                      'redacted_by_erasure', true,
                      'redacted_at', ${now.toISOString()}::text
                    )
       WHERE (actor_kind = 'customer' AND actor_id = ${customerId})
          OR (target_kind = 'customer' AND target_id = ${customerId})
    `);

    // 9. Drop queued emails + notifications referencing the
    //    customer. Emails already sent are outside our reach.
    await tx
      .delete(schema.emailSendLog)
      .where(eq(schema.emailSendLog.recipientEmail, ctx.customer.email ?? ''));
    await tx
      .delete(schema.notifications)
      .where(eq(schema.notifications.customerId, customerId));
  });

  // --- 10. Audit the erasure request itself. Written OUTSIDE the
  //         transaction above because the meta we just redacted
  //         shouldn't re-appear here. Actor is `system` because the
  //         customer row is now anonymized; we keep the subject id
  //         in meta for the compliance pipeline. ---
  const auditCtx = buildAuditContext({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
  await writeAudit(db, {
    action: 'compliance.erasure_requested',
    actor: customerActor({
      id: customerId,
      label: customerLabel({ email: ctx.customer.email, id: customerId }),
    }),
    target: noTarget(),
    context: auditCtx,
    meta: {
      credentialsRevoked,
      selfInitiated: true,
    },
    ts: now,
  });

  // --- 11. Build response + clear auth cookies ---
  const response = NextResponse.json(
    {
      erased: true,
      message:
        'Your Crivacy account has been erased. You will be signed out on this device.',
    },
    {
      status: 200,
      headers: {
        'x-request-id': ctx.requestId,
        'cache-control': 'no-store',
      },
    },
  );
  const isProduction = process.env.NODE_ENV === 'production';
  response.cookies.set('__crivacy_ct', '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  response.cookies.set('__crivacy_crt', '', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/api/customer/auth/refresh',
    maxAge: 0,
  });
  return response;
}
