/**
 * POST /api/customer/auth/wallet/link
 *
 * Link an Ethereum wallet to an existing customer account.
 * Requires the customer to be logged in and the wallet to sign a challenge.
 *
 * Edge cases:
 * - Wallet already linked to THIS customer → 200 (idempotent)
 * - Wallet linked to ANOTHER customer → 409
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
  claimWalletNonce,
  verifyWalletChallenge,
  verifyEvmWalletSignature,
} from '@/lib/customer/evm-wallet';
import {
  findLinkedAccount,
  createLinkedAccount,
} from '@/lib/customer/linked-accounts';

import { writeAudit } from '@/lib/audit/writer';
import { customerActor, customerLabel } from '@/lib/audit/actors';
import { noTarget } from '@/lib/audit/targets';
import { emitSecurityEvent } from '@/lib/security-events';
import { buildRequestContext as buildAuditContext } from '@/lib/audit/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LinkBody = z.object({
  challenge: z.string().min(1),
  message: z.string().min(1).max(4096),
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, 'signature must be 0x-prefixed hex')
    .max(4096),
  provider: z.literal('evm_wallet'),
  // Reauth: caller must re-prove they own the account before linking
  // a new credential. Without this, a stolen session = permanent
  // account takeover via the new wallet.
  currentPassword: existingPasswordSchema,
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

    // --- 0. Per-IP rate limit. Defence-in-depth over the nonce
    //        burn below, caps retry noise when the extension flakes.
    const limited = await maybeRateLimitResponse(db, 'customer_wallet_link', ctx.ip, now);
    if (limited) return limited;

    // --- 1. Parse body ---
    const body = await parseBody(ctx.request, LinkBody);

    // --- 1a. Reauth, linking a new wallet is a persistent-access
    //         mutation (attacker with stolen session could add their
    //         own wallet → permanent takeover via wallet login). We
    //         require currentPassword regardless of whether the
    //         customer has existing linked wallets; callers who
    //         registered via wallet-only and never set a password
    //         must first run the set-password flow.
    const authConfig = getAuthConfig();
    const passwordCheck = await db.execute<{ password_hash: string | null }>(
      sql`SELECT password_hash FROM customers WHERE id = ${customerId} LIMIT 1`,
    );
    const pwRow = passwordCheck.rows[0] as { password_hash: string | null } | undefined;
    if (pwRow === undefined || pwRow.password_hash === null) {
      return ctx.errorJson(
        'password_required',
        'Set a password first via settings → security before linking additional wallets.',
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

    // --- 2. Verify challenge JWT ---
    let nonce: string;
    try {
      nonce = await verifyWalletChallenge(body.challenge, authConfig.jwtSecret);
    } catch {
      return ctx.errorJson(
        'wallet_challenge_invalid',
        'Challenge expired or invalid. Please request a new one.',
        401,
      );
    }

    // --- 3. Verify the SIWE signature and recover the EVM address ---
    const address = await verifyEvmWalletSignature({
      message: body.message,
      signature: body.signature as `0x${string}`,
      expectedNonce: nonce,
    });
    if (address === null) {
      return ctx.errorJson(
        'wallet_signature_invalid',
        'Wallet signature verification failed.',
        401,
      );
    }

    // --- 3a. Burn the nonce BEFORE we check the linked-account
    //         table so a replayed `(challenge, signature)` pair
    //         cannot silently claim someone else's wallet for a
    //         second account. Same atomic `INSERT ... ON CONFLICT`
    //         guard the login and set-password paths use.
    const fresh = await claimWalletNonce(db, nonce, now);
    if (!fresh) {
      return ctx.errorJson(
        'wallet_challenge_invalid',
        'Wallet challenge has already been used. Please sign a fresh challenge.',
        401,
      );
    }

    // --- 4. Check if wallet is already linked ---
    const existing = await findLinkedAccount(db, 'evm_wallet', address);
    if (existing) {
      if (existing.customerId === customerId) {
        // Already linked to this customer, idempotent success
        return ctx.json({ linked: true, alreadyLinked: true });
      }
      // Linked to another customer
      return ctx.errorJson(
        'wallet_already_linked',
        'This wallet is already linked to another account.',
        409,
      );
    }

    // --- 5. Create linked account. F-A2-AG-001: ON CONFLICT DO
    //        NOTHING returns null when a race lands another link
    //        first. The pre-checked `existing` branch above already
    //        handles the steady-state case; null here means a
    //        concurrent insert won.
    const hint = `${address.slice(0, 6)}…${address.slice(-4)}`;
    const linkedId = await createLinkedAccount(
      db,
      customerId,
      'evm_wallet',
      address,
      null,
      hint,
    );
    if (linkedId === null) {
      return ctx.errorJson(
        'wallet_already_linked',
        'This wallet is already linked to another account.',
        409,
      );
    }

    // --- 5a. Revoke every OTHER customer session for this account.
    //         Linking a new wallet enlarges the login surface (one
    //         more key that can sign in as this customer); parallel
    //         sessions that weren't initiated by the real owner must
    //         lose access. Current session stays alive so the UI
    //         can show the new state without a forced re-login.
    await db.execute(
      sql`UPDATE customer_sessions
             SET revoked_at = ${now.toISOString()},
                 revoked_reason = 'wallet_linked'
           WHERE customer_id = ${customerId}
             AND revoked_at IS NULL
             AND id != ${ctx.session.sessionId}`,
    );

    // --- 6. Audit ---
    const auditCtx = buildAuditContext({
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
    await writeAudit(db, {
      action: 'customer.wallet_linked',
      actor: customerActor({ id: customerId, label: customerLabel(ctx.customer) }),
      target: noTarget(),
      context: auditCtx,
      meta: {
        provider: body.provider,
        walletAddress: address.slice(0, 16) + '...',
      },
      ts: now,
    });

    // F-XCC-AQ-AUTH-LINK-NO-NOTIFY-004, drive the user-facing
    // "wallet linked" email leg via the outbox. Audit row above is
    // the canonical record; this event's audit subscriber returns
    // null. Customers who linked the wallet without an email on file
    // (wallet-only with no email_added) silently skip the email.
    if (ctx.customer.email !== null) {
      await emitSecurityEvent({
        db,
        eventType: 'customer.wallet_linked',
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
          eventKind: 'added',
        },
        now,
      });
    }

    return ctx.json({ linked: true });
  },
});
