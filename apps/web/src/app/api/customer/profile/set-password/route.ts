/**
 * POST /api/customer/profile/set-password
 *
 * Set a password for a wallet-only account that has no password.
 * This is different from change-password which requires the current password.
 *
 * Guards:
 * - Customer must be logged in (customerRoute)
 * - Customer must NOT already have a password (409)
 */

import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { hashPassword } from '@/lib/auth/password';
import { assertPasswordNotPwned } from '@/lib/auth/pwned-passwords';
import { reauthFailureResponse, walletReauthGate } from '@/lib/auth/reauth';
import { getDatabaseClient } from '@/lib/db/client';
import { withIdempotency } from '@/lib/http/with-idempotency';
import { emitSecurityEvent } from '@/lib/security-events';
import { customerRoute } from '@/server/middleware/customer-route';
import { parseBody } from '@/server/middleware/parse';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

import { newPasswordSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Wallet re-signature proof sent by email-less wallet-only customers
 * alongside the new password. Mirrors the shape the normal
 * `/api/customer/auth/wallet/verify` endpoint accepts, so the
 * frontend can reuse the existing `/wallet/challenge` +
 * extension-signing path. Every field is required when the proof
 * itself is sent; the whole object is optional in the body because
 * customers who already have an email skip this step.
 */
const WalletProofSchema = z.object({
  challenge: z.string().min(1),
  message: z.string().min(1).max(4096),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'signature must be 0x-prefixed hex')
    .max(4096),
});

const SetPasswordBody = z.object({
  password: newPasswordSchema,
  walletProof: WalletProofSchema.optional(),
});

export const POST = customerRoute({
  authConfig: getAuthConfig,
  sessionLookup: lookupCustomerSession,
  customerLookup: lookupCustomer,
  dbFactory: () => getDatabaseClient().db,
  handler: async (ctx) => {
    const db = ctx.db;
    const now = ctx.now;
    const customerId = ctx.customer.id;

    // --- 0. Per-IP rate limit. Belt-and-suspenders over the
    //        idempotent 409-after-first behaviour, caps notification
    //        email volume if a stolen session spams the endpoint.
    const limited = await maybeRateLimitResponse(db, 'customer_set_password', ctx.ip, now);
    if (limited) return limited;

    // --- 1. Parse body ---
    const body = await parseBody(ctx.request, SetPasswordBody);

    // --- 2. Idempotency-wrapped: `password_already_set` check lives
    //        INSIDE the HOF so a retry with the same Idempotency-Key
    //        replays the original 200 rather than short-circuiting
    //        on the 409 the rotated-hash state would now produce.
    //        Without this split, a double-submit would see the first
    //        success followed by a confusing 409 even though the
    //        caller's click was the same logical operation.
    const authConfig = getAuthConfig();
    return withIdempotency(
      {
        ctx,
        endpoint: 'customer.profile.set-password',
        subject: { kind: 'customer', id: customerId },
        body,
      },
      async () => {
        // Check if customer already has a password.
        const hashResult = await db.execute<{ password_hash: string | null }>(
          sql`SELECT password_hash FROM customers WHERE id = ${customerId} LIMIT 1`,
        );
        const hashRow = hashResult.rows[0] as { password_hash: string | null } | undefined;
        if (!hashRow) {
          return ctx.errorJson('internal_error', 'Account not found.', 500);
        }
        if (hashRow.password_hash !== null) {
          return ctx.errorJson(
            'password_already_set',
            'Password is already set. Use change-password to modify it.',
            409,
          );
        }

        // Step-up auth gate for email-less wallet-only accounts.
        // Explanation in the original inline block (retained in git
        // history); summary, wallet signature required when no
        // email is on file, breaks the stolen-cookie takeover chain.
        if (ctx.customer.email === null) {
          if (!body.walletProof) {
            return ctx.errorJson(
              'wallet_proof_required',
              'Wallet signature is required before setting a password on an email-less account.',
              400,
            );
          }
          const reauth = await walletReauthGate({
            db,
            customerId,
            proof: {
              type: 'wallet',
              challenge: body.walletProof.challenge,
              message: body.walletProof.message,
              signature: body.walletProof.signature,
            },
            now,
            authConfig,
          });
          if (reauth.status === 'failed') {
            const mapped = reauthFailureResponse(reauth.reason);
            return ctx.errorJson(mapped.code, mapped.message, mapped.status);
          }
        }

        await assertPasswordNotPwned(body.password);
        const newHash = await hashPassword(body.password, authConfig);

        // State change + outbox emit atomic. See change-password route
        // for the rationale.
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE customers
             SET password_hash = ${newHash}, updated_at = ${now.toISOString()}
             WHERE id = ${customerId}`,
          );
          await tx.execute(
            sql`UPDATE customer_sessions
             SET revoked_at = ${now.toISOString()},
                 revoked_reason = 'password_set'
             WHERE customer_id = ${customerId}
               AND revoked_at IS NULL
               AND id != ${ctx.session.sessionId}`,
          );
          await emitSecurityEvent({
            db: tx,
            eventType: 'customer.password_set',
            subject: { kind: 'customer', id: customerId },
            payload: {
              auditContext: {
                ip: ctx.ip,
                userAgent: ctx.userAgent,
                requestId: ctx.requestId,
              },
              sessionId: ctx.session.sessionId,
              email: ctx.customer.email,
              displayName:
                ctx.customer.displayName ??
                ctx.customer.email?.split('@')[0] ??
                'User',
              reason: 'set',
              securityUrlPath: '/settings/security',
            },
            now,
          });
        });

        return ctx.json({ passwordSet: true });
      },
    );
  },
});
