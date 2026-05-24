/**
 * POST /api/customer/profile/add-email
 *
 * Add an email address to a wallet-only account. The email must be
 * verified via the existing verify-email flow before it becomes
 * active.
 *
 * Guards:
 *   - Customer must be logged in (customerRoute)
 *   - Customer must NOT already have an email (409)
 *   - Per-IP rate limit (customer_add_email)
 *   - **Wallet re-signature required**: the only callers reaching
 *     this endpoint are wallet-only customers (the `email === null`
 *     gate below enforces that). We require a fresh signature from
 *     the linked wallet so a stolen session cookie cannot chain
 *     `add-email` → (set-password is already gated) into a silent
 *     takeover, the wallet key stays on the user's device and the
 *     attacker cannot produce a valid signature without it.
 *   - Email enumeration is closed the same way the change-email
 *     endpoint closed it: any "target address is already in use"
 *     outcome returns the same generic response shape as a success,
 *     with a notification dispatched to the real owner out-of-band.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { maybeRateLimitResponse } from '@/lib/auth-rate-limit';
import { getAuthConfig } from '@/lib/auth/config';
import { reauthFailureResponse, walletReauthGate } from '@/lib/auth/reauth';
import { getDatabaseClient } from '@/lib/db/client';
import { getAppUrl } from '@/lib/env/app-url';
import { runOrCatchUnique } from '@/lib/db/unique-violation';
import { withIdempotency } from '@/lib/http/with-idempotency';
import { emitSecurityEvent } from '@/lib/security-events';
import { customerRoute } from '@/server/middleware/customer-route';
import { parseBody } from '@/server/middleware/parse';
import { lookupCustomerSession, lookupCustomer } from '@/lib/customer/lookup';

import { enqueueEmailFromRoute } from '@/lib/email/enqueue-from-route';
import { emailChangeAttemptedEmail } from '@/lib/email/templates';
import { emailSchema } from '@/lib/validation/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Wallet re-signature proof. Mirrors the shape of the normal
 * `/api/customer/auth/wallet/verify` payload so the frontend can
 * reuse the existing `/wallet/challenge` + extension-signing path.
 */
const WalletProofSchema = z.object({
  challenge: z.string().min(1),
  message: z.string().min(1).max(4096),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'signature must be 0x-prefixed hex')
    .max(4096),
});

const AddEmailBody = z.object({
  email: emailSchema,
  walletProof: WalletProofSchema,
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

    // --- 0. Per-IP rate limit ---
    const limited = await maybeRateLimitResponse(db, 'customer_add_email', ctx.ip, now);
    if (limited) return limited;

    // --- 1. Parse body ---
    const body = await parseBody(ctx.request, AddEmailBody);
    const emailLower = body.email.toLowerCase().trim();

    // Idempotency-wrapped. Same rationale as set-password: the
    // `email_already_set` 409 would fire on a retry because step 1
    // already attached the email, the HOF replays the original
    // 200 instead. The wallet proof's nonce is burned by
    // walletReauthGate on first run, so a retry without idempotency
    // would additionally fail the nonce-replay check.
    const authConfig = getAuthConfig();
    return withIdempotency(
      {
        ctx,
        endpoint: 'customer.profile.add-email',
        subject: { kind: 'customer', id: customerId },
        body,
      },
      async () => {
        // Re-read the fresh state INSIDE the HOF so the 409 reflects
        // the post-retry DB rather than a stale ctx.customer snapshot.
        const freshCustomer = await db.execute<{ email: string | null }>(
          sql`SELECT email FROM customers WHERE id = ${customerId} LIMIT 1`,
        );
        const freshEmail = (freshCustomer.rows[0] as { email: string | null } | undefined)
          ?.email;
        if (freshEmail !== null && freshEmail !== undefined) {
          return ctx.errorJson(
            'email_already_set',
            'Email is already set. Use change-email to modify it.',
            409,
          );
        }

        // Wallet signature reauth, walletReauthGate burns the
        // nonce, so a retry without a fresh signature fails
        // `wallet_challenge_invalid`. That's fine: the HOF's
        // replay is the retry-safe path; a retry WITHOUT the
        // same Idempotency-Key must mint a new signature anyway.
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

        // Blacklist check, short-circuits silently (no email).
        const emailHash = createHash('sha256').update(emailLower).digest('hex');
        const blacklisted = await db.execute<{ count: string }>(
          sql`SELECT COUNT(*)::text AS count FROM customer_blacklist WHERE email_hash = ${emailHash}`,
        );
        const isBlacklisted =
          parseInt((blacklisted.rows[0] as { count: string } | undefined)?.count ?? '0', 10) > 0;

        let outcome: 'attached' | 'target_taken_notified' | 'target_blacklisted_silent';

        if (isBlacklisted) {
          outcome = 'target_blacklisted_silent';
        } else {
          const attachResult = await runOrCatchUnique(
            () =>
              db.execute(
                sql`UPDATE customers
                       SET email = ${emailLower},
                           status = 'pending_verification',
                           updated_at = ${now.toISOString()}
                     WHERE id = ${customerId}`,
              ),
            ['customers_email_key'],
          );

          if (attachResult.status === 'ok') {
            outcome = 'attached';
            // Attaching an email enlarges the recovery surface, once
            // a password is set, a reset code can now reach this
            // account via the inbox. Revoke every OTHER customer
            // session so parallel browsers/devices that weren't
            // initiated by the real owner lose access. Current
            // session stays alive to surface the new state.
            await db.execute(
              sql`UPDATE customer_sessions
                     SET revoked_at = ${now.toISOString()},
                         revoked_reason = 'email_added'
                   WHERE customer_id = ${customerId}
                     AND revoked_at IS NULL
                     AND id != ${ctx.session.sessionId}`,
            );
          } else {
            // Collision, notify real owner out-of-band, keep
            // requester's response identical.
            const ownerRow = await db.execute<{ id: string }>(
              sql`SELECT id FROM customers
                    WHERE lower(email) = ${emailLower} AND deleted_at IS NULL
                    LIMIT 1`,
            );
            const ownerId = (ownerRow.rows[0] as { id: string } | undefined)?.id;
            if (ownerId !== undefined) {
              const appUrl = getAppUrl();
              const notification = emailChangeAttemptedEmail({
                displayName: emailLower.split('@')[0] ?? 'there',
                loginUrl: `${appUrl}/login`,
              });
              await enqueueEmailFromRoute(db, {
                to: emailLower,
                content: notification,
                emailType: 'notification',
                userId: ownerId,
              });
            }
            outcome = 'target_taken_notified';
          }
        }

        // Emit the audit event through the outbox. The attach UPDATE
        // above is not wrapped in a transaction here, the helper
        // runs its own atomic UPDATE and the notification email (in
        // the `target_taken_notified` branch) is queued through the
        // email worker, so there is no "audit without state" gap to
        // close. The emit is best-effort post-commit for this endpoint.
        await emitSecurityEvent({
          db,
          eventType: 'customer.email_added',
          subject: { kind: 'customer', id: customerId },
          payload: {
            auditContext: {
              ip: ctx.ip,
              userAgent: ctx.userAgent,
              requestId: ctx.requestId,
            },
            email: emailLower,
            outcome,
          },
          now,
        });

        return ctx.json({ emailSet: true, needsVerification: true });
      },
    );
  },
});
