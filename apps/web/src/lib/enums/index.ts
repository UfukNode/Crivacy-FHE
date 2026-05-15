/**
 * Shared enum metadata for UI surfaces.
 *
 * Frontend pages (webhooks form, playground, oauth-clients,
 * api-keys) import the `_VALUES` arrays + `_METADATA` maps from
 * here instead of hardcoding their own copy of the enum values.
 * The `satisfies Record<EnumType, ...>` constraints on each
 * metadata map make drift a compile error rather than a silent
 * runtime bug — if a new enum value lands in the canonical Zod
 * source without a metadata entry, this file fails to type-check
 * and every consumer stays correct by construction.
 */

export {
  API_KEY_SCOPE_METADATA,
  API_KEY_SCOPE_VALUES,
  type ApiKeyScopeValue,
} from './api-key-scopes';

export {
  OAUTH_SCOPE_METADATA,
  OAUTH_SCOPE_VALUES,
  levelHint,
  type OauthScopeId,
  type ScopeRequiredLevel,
} from './oauth-scopes';

export {
  WEBHOOK_EVENT_METADATA,
  WEBHOOK_EVENT_VALUES,
  type WebhookEvent,
} from './webhook-events';
