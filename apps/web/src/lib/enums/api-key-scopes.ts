/**
 * UI metadata for `ApiKeyScope` values.
 *
 * Same contract as the webhook events module: the canonical enum
 * is the Zod `ApiKeyScope` in `lib/openapi/schemas/enums.ts`; this
 * file layers UI-facing labels + short explanations. `satisfies`
 * enforces that every scope has metadata and no orphans exist.
 *
 * @module
 */

import type { z } from 'zod';

import { ApiKeyScope } from '@/lib/openapi/schemas/enums';

export type ApiKeyScopeValue = z.infer<typeof ApiKeyScope>;

export const API_KEY_SCOPE_VALUES: readonly ApiKeyScopeValue[] = ApiKeyScope.options;

export const API_KEY_SCOPE_METADATA = {
  'kyc:create': {
    label: 'kyc:create',
    description: 'Create new KYC sessions for your customers.',
  },
  'kyc:read': {
    label: 'kyc:read',
    description: 'Read sessions + credentials you issued.',
  },
  'kyc:verify': {
    label: 'kyc:verify',
    description: 'Verify credential proof hashes against the on-chain contract.',
  },
  'webhooks:manage': {
    label: 'webhooks:manage',
    description: 'Register, list, update, rotate, or delete webhook subscriptions.',
  },
  'usage:read': {
    label: 'usage:read',
    description: 'Read your current rate-limit + monthly quota snapshot.',
  },
} as const satisfies Record<
  ApiKeyScopeValue,
  { readonly label: string; readonly description: string }
>;
