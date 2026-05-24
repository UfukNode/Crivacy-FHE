/**
 * DELETE /api/customer/auth/wallet/unlink
 *
 * Unlink the Ethereum wallet from the customer's account.
 *
 * Guards (mirrors `/api/customer/auth/google/unlink`, F-A2-F1-001
 * Cat 14 cluster, F-A3-F1-001-PRE Page 3 pre-flight parity fix):
 * - Customer must be logged in
 * - Per-IP rate limit `customer_wallet_unlink` (5/15min)
 * - Reauth gate: caller proves password ownership before stripping a
 *   sign-in method. A stolen session alone cannot remove credentials,
 *   which would otherwise let an attacker disrupt the legit owner's
 *   recovery options.
 * - Anti-enumeration ordering: reauth runs BEFORE the `is wallet
 *   linked?` 404 so a captured session cannot probe link state by
 *   diffing 401 vs 404.
 * - Customer must retain at least one alternative auth method
 *   (email+pwd or Google), `sole_auth_method` 409 otherwise.
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { reauthFailureResponse, reauthGate } from '@/lib/auth/reauth';
import { getDatabaseClient } from '@/lib/db/client';
import { customerRoute } from '@/server/middleware/customer-route';
import { parseBody } from '@/server/middleware/parse';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';
import { existingPasswordSchema } from '@/lib/validation/auth';

import {
  listLinkedAccounts,
  removeLinkedAccount,
} from '@/lib/customer/linked-accounts';

import { writeAudit } from '@/lib/audit/writer';
import { customerActor, customerLabel } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';
import { emitSecurityEvent } from '@/lib/security-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UnlinkBody = z.object({
  currentPassword: existingPasswordSchema,
});

export const DELETE = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
  handler: async (ctx) => {
    const db = ctx.db;
    const now = ctx.now;
    const customerId = ctx.customer.id;

    // --- 0. Per-IP rate limit. The endpoint is idempotent (404 after
    //        the first unlink) but caps spam over a stolen session
    //        cookie that would otherwise hammer the audit trail.
    const limited = await maybeRateLimitResponse(db, 'customer_wallet_unlink', ctx.ip, now);
    if (limited) return limited;

    // --- 1. Parse body, currentPassword is the reauth proof. Same
    //        schema shape as google/unlink so a stolen session that
    //        lacks the password fails before any DB-revealing branches.
    const body = await parseBody(ctx.request, UnlinkBody);

    // --- 1a. Reauth gate (Cat 14, F-A3-F1-001-PRE). Wallet-only
    //         customers must run set-password first before they can
    //         manage other credentials; a missing password_hash short-
    //         circuits with 400 password_required so the UI can show
    //         the actionable next step. After the password gate the
    //         reauthGate runs with `factor: { type: 'none' }` because
    //         the customer audience does not have TOTP.
    const authConfig = getAuthConfig();
    const passwordCheck = await db.execute<{ password_hash: string | null }>(
      sql`SELECT password_hash FROM customers WHERE id = ${customerId} LIMIT 1`,
    );
    const pwRow = passwordCheck.rows[0] as { password_hash: string | null } | undefined;
    if (pwRow === undefined || pwRow.password_hash === null) {
      return ctx.errorJson(
        'password_required',
        'Set a password first via settings → security before unlinking the wallet.',
        400,
      );
    }
    const reauth = await reauthGate({
      db,
      subject: { kind: 'customer', id: customerId },
      password: body.currentPassword,
      factor: { type: 'none' },
      now,
      authConfig,
    });
    if (reauth.status === 'failed') {
      const mapped = reauthFailureResponse(reauth.reason);
      return ctx.errorJson(mapped.code, mapped.message, mapped.status);
    }

    // --- 2. Check if wallet is actually linked. Runs AFTER reauth so
    //        a stolen-session attacker cannot probe link state by
    //        comparing 401 vs 404 responses.
    const accounts = await listLinkedAccounts(db, customerId);
    const walletAccount = accounts.find((a) => a.provider === 'evm_wallet');
    if (!walletAccount) {
      return ctx.errorJson('not_linked', 'No wallet is linked to this account.', 404);
    }

    // --- 3. Check if customer has alternative auth methods.
    //        password_hash already proven set above, so email+pwd is a
    //        viable alternative if email is also set; otherwise Google
    //        link must exist.
    const hasEmailAndPassword = ctx.customer.email !== null;
    const hasGoogle = accounts.some((a) => a.provider === 'google');

    if (!hasEmailAndPassword && !hasGoogle) {
      return ctx.errorJson(
        'sole_auth_method',
        'Cannot remove your only login method. Add an email and password or link Google first.',
        409,
      );
    }

    // --- 3b. Credential-binding guard (FHE design invariant).
    //         The customer's KYC credential is keyed on-chain by this
    //         wallet address (`_cred[wallet]` on CrivacyKYC) and only this
    //         wallet can decrypt its encrypted fields. Unlinking while a
    //         credential is active would ORPHAN it: the account would no
    //         longer point to the address that owns the on-chain record,
    //         and the customer would permanently lose the decryption path.
    //         Require the credential to be revoked first. `userRef` holds
    //         the customer id for self-service credentials (same key the
    //         /kyc status + pipeline use).
    const activeCred = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n
            FROM kyc_credentials_meta
           WHERE user_ref = ${customerId}
             AND status = 'active'`,
    );
    if ((activeCred.rows[0]?.n ?? 0) > 0) {
      return ctx.errorJson(
        'wallet_bound_to_credential',
        'This wallet holds your active on-chain KYC credential and is the only key that can decrypt it. Revoke your credential before unlinking the wallet.',
        409,
      );
    }

    // --- 4. Remove the linked account.
    await removeLinkedAccount(db, customerId, 'evm_wallet');

    // --- 4a. Revoke every OTHER customer session. Removing a login
    //         method is a credential mutation; parallel sessions
    //         established while the wallet was the auth method must
    //         be torn down so the "one credential change = forced
    //         re-auth on every other device" invariant holds. Current
    //         session stays alive so the UI can confirm new state.
    await db.execute(
      sql`UPDATE customer_sessions
             SET revoked_at = ${now.toISOString()},
                 revoked_reason = 'wallet_unlinked'
           WHERE customer_id = ${customerId}
             AND revoked_at IS NULL
             AND id != ${ctx.session.sessionId}`,
    );

    // --- 5. Audit.
    const auditCtx = buildAuditContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
    await writeAudit(db, {
      action: 'customer.wallet_unlinked',
      actor: customerActor({ id: customerId, label: customerLabel(ctx.customer) }),
      target: noTarget(),
      context: auditCtx,
      meta: { provider: 'evm_wallet' },
      ts: now,
    });

    // F-XCC-AQ-AUTH-LINK-NO-NOTIFY-004, email leg via outbox.
    if (ctx.customer.email !== null) {
      await emitSecurityEvent({
        db,
        eventType: 'customer.wallet_unlinked',
        subject: { kind: 'customer', id: customerId },
        payload: {
          auditContext: {
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            requestId: ctx.requestId,
          },
          email: ctx.customer.email,
          displayName:
            ctx.customer.displayName ??
            ctx.customer.email.split('@')[0] ??
            'there',
          provider: 'wallet',
          eventKind: 'removed',
        },
        now,
      });
    }

    return ctx.json({ unlinked: true });
  },
});
