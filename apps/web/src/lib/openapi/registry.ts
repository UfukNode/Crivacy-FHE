/**
 * OpenAPI registry — the single source of truth for request/response schemas
 * and route definitions.
 *
 * Extending Zod with `.openapi(...)` must happen before any schema is
 * defined; otherwise the fluent call site is a compile error. We do it here
 * as a module top-level side effect and re-export the extended `z` so every
 * schema file imports from this module instead of directly from `zod`. That
 * convention makes the dependency ordering obvious and prevents accidental
 * "unextended z" bugs.
 *
 * The single `OpenAPIRegistry` instance is exported as a named singleton.
 * Route files call `registry.registerPath(...)` as a side effect during the
 * module's initial evaluation; `build-spec.ts` imports the routes barrel to
 * trigger those side effects, then passes `registry.definitions` to
 * `OpenApiGeneratorV31`. The registry is internal to the openapi module —
 * runtime request handlers (PLAN.md step 10) import schemas, not the
 * registry itself.
 */

import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export { z };

export const registry = new OpenAPIRegistry();

/**
 * Tag catalog — the OpenAPI spec groups operations by tag. Keeping the full
 * list here means the generator can emit `tags` in the document with
 * descriptions in a stable order, and every route file imports names from
 * this record instead of stringly-typed literals.
 */
export const OpenApiTags = {
  Sessions: 'Sessions',
  Credentials: 'Credentials',
  Webhooks: 'Webhooks',
  Usage: 'Usage',
  Limits: 'Limits',
  Health: 'Health',
  InternalAuth: 'Internal — Auth',
  InternalFirm: 'Internal — Firm',
  InternalApiKeys: 'Internal — API Keys',
  InternalUsage: 'Internal — Usage',
  InternalWebhooks: 'Internal — Webhooks',
  InternalAudit: 'Internal — Audit',
  InternalPlayground: 'Internal — Playground',
  AdminFirms: 'Admin — Firms',
  AdminSystem: 'Admin — System',
  AdminStatus: 'Admin — Status',
  IncomingWebhooks: 'Incoming Webhooks',
} as const;

export type OpenApiTagName = (typeof OpenApiTags)[keyof typeof OpenApiTags];

export const orderedTags: readonly {
  name: OpenApiTagName;
  description: string;
}[] = [
  {
    name: OpenApiTags.Sessions,
    description:
      'Create and read KYC verification sessions. A session represents an end user going through Didit identity capture before a credential is minted on Sepolia.',
  },
  {
    name: OpenApiTags.Credentials,
    description:
      'Read and verify on-chain-issued KYC credentials. A credential is the immutable attestation that an end user passed the verification flow.',
  },
  {
    name: OpenApiTags.Webhooks,
    description:
      'Manage webhook subscriptions for asynchronous events (credential lifecycle, session state changes).',
  },
  {
    name: OpenApiTags.Usage,
    description: 'Inspect API usage for the current billing period and historical months.',
  },
  {
    name: OpenApiTags.Limits,
    description:
      'Read the tier configuration and remaining rate-limit / quota capacity for the authenticating API key.',
  },
  {
    name: OpenApiTags.Health,
    description: 'Liveness probes and public component status. Safe to hit without authentication.',
  },
  {
    name: OpenApiTags.InternalAuth,
    description: 'Dashboard session management — login, logout, token refresh, TOTP enrollment.',
  },
  {
    name: OpenApiTags.InternalFirm,
    description: 'Firm profile and settings for dashboard users.',
  },
  {
    name: OpenApiTags.InternalApiKeys,
    description: 'Dashboard-side API key issuance, rotation, revocation.',
  },
  {
    name: OpenApiTags.InternalUsage,
    description: 'Dashboard usage charts fed by the aggregated usage rollups.',
  },
  {
    name: OpenApiTags.InternalWebhooks,
    description: 'Dashboard webhook delivery inspection and manual replay.',
  },
  {
    name: OpenApiTags.InternalAudit,
    description: 'Audit log readback for privileged firm operations.',
  },
  {
    name: OpenApiTags.InternalPlayground,
    description:
      'Interactive playground that proxies a request to the real public API using a test-mode API key.',
  },
  {
    name: OpenApiTags.AdminFirms,
    description: 'Crivacy admin — firm lifecycle, tier overrides, quota overrides, soft-delete.',
  },
  {
    name: OpenApiTags.AdminSystem,
    description: 'Crivacy admin — internal system metrics, queue depths, operational dashboards.',
  },
  {
    name: OpenApiTags.AdminStatus,
    description:
      'Crivacy admin — publish incidents and component state updates to the public status page.',
  },
  {
    name: OpenApiTags.IncomingWebhooks,
    description:
      'Endpoints Crivacy hosts to receive events from upstream providers (currently Didit).',
  },
];
