/**
 * GET /api/internal/api-keys, list API keys
 * POST /api/internal/api-keys, create API key
 */

import type { ApiKeyMode, ApiKeyScope } from '@crivacy/shared-types';

import { getAuthConfig } from '@/lib/auth/config';
import {
  reauthEnvelopeShape,
  requireTotpReauth,
} from '@/lib/auth/destructive-reauth';
import { handleCreateApiKey, handleListApiKeys } from '@/server/handlers';
import { dashboardRoute } from '@/server/middleware';
import { parseBody } from '@/server/middleware/parse';
import {
  countActiveApiKeysByFirm,
  findFirmByIdForMiddleware,
  findFirmUserByIdForMiddleware,
  findSessionByJtiForMiddleware,
  insertApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from '@/server/repositories';

import { createApiKeySchema } from '@/lib/validation/api-key';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// AUD-X-THREAT-001 + BUG #58: route body extends the persisted
// `createApiKeySchema` with the destructive-reauth envelope
// (currentPassword + totpCode). Creating an API key mints a new
// auth primitive that pulls every firm-scoped resource via
// `/api/v1/*`, a stolen session with the password alone must
// still fail the TOTP layer.
const CreateApiKeyBody = createApiKeySchema.extend(reauthEnvelopeShape);

function getDeps() {
  const cfg = getAuthConfig();
  return {
    authConfig: { apiKeyBcryptCost: cfg.apiKeyBcryptCost },
    listKeys: listApiKeys,
    countActiveKeys: countActiveApiKeysByFirm,
    insertKey: insertApiKey,
    revokeKey: revokeApiKey,
    rotateKey: rotateApiKey,
  };
}

export const GET = dashboardRoute({
  permission: 'api_key.read',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const keys = await handleListApiKeys(getDeps(), ctx);
    // `{ data, pagination }` envelope, MEMORY.md'deki merkezi list
    // contract. API keys tier-cap ile natural limitli (5-20 key),
    // cursor pagination gereksiz; nextCursor=null + limit=count ile
    // consistent shape sunuluyor (AUD-X-ENVELOPE-001 fix).
    return ctx.json({ data: keys, pagination: { nextCursor: null, limit: keys.length } });
  },
});

export const POST = dashboardRoute({
  // Matrix: Member+ can create API keys. `minRole: 'member'` kept as
  // the belt; `permission: 'api_key.create'` is the suspenders.
  permission: 'api_key.create',
  authConfig: getAuthConfig,
  sessionLookup: findSessionByJtiForMiddleware,
  firmUserLookup: findFirmUserByIdForMiddleware,
  firmLookup: findFirmByIdForMiddleware,
  handler: async (ctx) => {
    const body = await parseBody(ctx.request, CreateApiKeyBody);

    // BUG #58: password + TOTP reauth before creation. The TOTP
    // layer is what blocks a session thief who already has the
    // password (phishing, infostealer, password-reuse), rate
    // limit and lockout cannot help when every request carries a
    // valid password.
    const authConfig = getAuthConfig();
    const reauth = await requireTotpReauth({
      db: ctx.db,
      subject: { kind: 'firm', id: ctx.user.id },
      envelope: {
        currentPassword: body.currentPassword,
        totpCode: body.totpCode,
      },
      now: ctx.now,
      authConfig,
    });
    if (reauth.status === 'denied') {
      return ctx.errorJson(reauth.code, reauth.message, reauth.httpStatus);
    }

    const result = await handleCreateApiKey(getDeps(), ctx, {
      name: body.name,
      mode: body.mode as ApiKeyMode,
      scopes: body.scopes as ApiKeyScope[],
      ...(body.expiresAt !== undefined ? { expiresAt: new Date(body.expiresAt) } : {}),
    });
    if (result.status === 'tier_exceeded') {
      return ctx.errorJson(
        'tier_forbidden',
        `Your ${result.tier} tier allows at most ${String(result.maxSlots)} active API key${
          result.maxSlots === 1 ? '' : 's'
        }. Revoke an existing key or upgrade to register more.`,
        403,
      );
    }
    return ctx.json(result.key, 201);
  },
});
