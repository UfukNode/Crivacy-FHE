/**
 * API key schemas — issuance, rotation, revocation.
 *
 * Plaintext keys are revealed exactly once, on creation or rotation.
 * Every other endpoint returns a masked prefix only.
 */

import { DateTimeIso, DisplayName } from '../common/primitives';
import { z } from '../registry';
import { ApiKeyMode, ApiKeyScope } from './enums';
import { ApiKeyId } from './identifiers';

export const ApiKeyPrefix = z
  .string()
  .regex(/^crv_(live|test)_[A-Za-z0-9]{4}$/, {
    message: 'Must be `crv_live_XXXX` or `crv_test_XXXX`.',
  })
  .openapi('ApiKeyPrefix', {
    description: 'First 13 characters of an API key, safe to show in the UI.',
    example: 'crv_live_k3n4',
  });
export type ApiKeyPrefix = z.infer<typeof ApiKeyPrefix>;

export const ApiKeyPlaintext = z
  .string()
  .regex(/^crv_(live|test)_[A-Za-z0-9_-]{32,}$/, {
    message: 'Must be a full `crv_live_*` or `crv_test_*` plaintext key.',
  })
  .openapi('ApiKeyPlaintext', {
    description:
      'Full plaintext API key. Returned exactly once on creation or rotation. Persisted server-side as a bcrypt hash only.',
    example: 'crv_live_k3n4rqLZ9pFJ8xYh2sQw7VcN5Tm1Xd6Bo',
  });
export type ApiKeyPlaintext = z.infer<typeof ApiKeyPlaintext>;

export const ApiKeySummary = z
  .object({
    id: ApiKeyId,
    prefix: ApiKeyPrefix,
    name: DisplayName,
    mode: ApiKeyMode,
    scopes: z.array(ApiKeyScope).min(1),
    createdAt: DateTimeIso,
    lastUsedAt: DateTimeIso.nullable(),
    expiresAt: DateTimeIso.nullable(),
    revokedAt: DateTimeIso.nullable(),
  })
  .openapi('ApiKeySummary', {
    description:
      'Compact API key view. Structurally identical to `ApiKeySummary` in `@crivacy/shared-types`.',
  });
export type ApiKeySummary = z.infer<typeof ApiKeySummary>;

export const ApiKeyCreateRequest = z
  .object({
    name: DisplayName,
    mode: ApiKeyMode,
    scopes: z.array(ApiKeyScope).min(1).max(8),
    expiresAt: DateTimeIso.optional(),
  })
  .openapi('ApiKeyCreateRequest', {
    description: 'Payload for `POST /api/internal/api-keys`.',
  });
export type ApiKeyCreateRequest = z.infer<typeof ApiKeyCreateRequest>;

export const ApiKeyWithSecretResponse = ApiKeySummary.extend({
  plaintext: ApiKeyPlaintext,
}).openapi('ApiKeyWithSecretResponse', {
  description:
    'Response for `POST /api/internal/api-keys` and `POST /api/internal/api-keys/:id/rotate`. The `plaintext` field is only ever returned from these two endpoints.',
});
export type ApiKeyWithSecretResponse = z.infer<typeof ApiKeyWithSecretResponse>;
