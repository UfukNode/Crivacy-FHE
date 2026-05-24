/**
 * DELETE /api/customer/auth/google/unlink
 *
 * Unlink Google from the customer's account.
 *
 * Guards:
 * - Customer must be logged in
 * - Per-IP rate limit (Cat 14 + Page 2 closure F-A2-001)
 * - Reauth gate: the caller must re-prove they own the password
 *   before stripping a sign-in method (Cat 14 wallet/link parite,
 *   F-A2-F1-001). A stolen session alone cannot remove credentials,
 *   which would otherwise let an attacker disrupt the legit owner
 *   from regaining access through the unlinked path.
 * - Customer must have at least one other auth method (email+pwd OR
 *   wallet) to prevent locking themselves out.
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

    // --- 0. Per-IP rate limit. Defence against a stolen session
    //        cookie that would otherwise hammer the audit trail.
    const limited = await maybeRateLimitResponse(db, 'customer_oauth_unlink', ctx.ip, now);
    if (limited) return limited;

    // --- 1. Parse body, currentPassword is the reauth proof. Same
    //        schema as wallet/link so a stolen session that lacks
    //        the password fails before any DB-revealing branches.
    const body = await parseBody(ctx.request, UnlinkBody);

    // --- 1a. Reauth gate (Cat 14, F-A2-F1-001). The pattern mirrors
    //         /auth/wallet/link: pre-check that a password is set
    //         (wallet-only customers must run set-password first
    //         before they can manage other credentials), then run
    //         reauthGate with `factor: { type: 'none' }` because the
    //         customer audience does not have TOTP.
    const authConfig = getAuthConfig();
    const passwordCheck = await db.execute<{ password_hash: string | null }>(
      sql`SELECT password_hash FROM customers WHERE id = ${customerId} LIMIT 1`,
    );
    const pwRow = passwordCheck.rows[0] as { password_hash: string | null } | undefined;
    if (pwRow === undefined || pwRow.password_hash === null) {
      return ctx.errorJson(
        'password_required',
        'Set a password first via settings → security before unlinking Google.',
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

    // --- 2. Check if Google is actually linked. Runs AFTER reauth so
    //        a stolen-session attacker cannot probe link state by
    //        comparing 401 vs 404 responses.
    const accounts = await listLinkedAccounts(db, customerId);
    const googleAccount = accounts.find((a) => a.provider === 'google');
    if (!googleAccount) {
      return ctx.errorJson('not_linked', 'No Google account is linked.', 404);
    }

    // --- 3. Check if customer has alternative auth methods.
    const hasEmailAndPassword = ctx.customer.email !== null;
    const hasWallet = accounts.some((a) => a.provider === 'evm_wallet');

    if (!hasEmailAndPassword && !hasWallet) {
      return ctx.errorJson(
        'sole_auth_method',
        'Cannot remove your only login method. Add an email and password or link a wallet first.',
        409,
      );
    }

    // --- 4. Remove the linked account.
    await removeLinkedAccount(db, customerId, 'google');

    // --- 4a. Revoke every OTHER customer session. Removing a login
    //         method is a credential mutation, parallel sessions
    //         established while Google was linked must be torn down
    //         so the "one credential change = forced re-auth on
    //         every other device" invariant holds. Current session
    //         kept alive.
    await db.execute(
      sql`UPDATE customer_sessions
             SET revoked_at = ${now.toISOString()},
                 revoked_reason = 'google_unlinked'
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
      action: 'customer.google_unlinked',
      actor: customerActor({ id: customerId, label: customerLabel(ctx.customer) }),
      target: noTarget(),
      context: auditCtx,
      meta: { provider: 'google' },
      ts: now,
    });

    // F-XCC-AQ-AUTH-LINK-NO-NOTIFY-004, email leg via outbox.
    if (ctx.customer.email !== null) {
      await emitSecurityEvent({
        db,
        eventType: 'customer.google_unlinked',
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
          provider: 'google',
          eventKind: 'removed',
        },
        now,
      });
    }

    return ctx.json({ unlinked: true });
  },
});
