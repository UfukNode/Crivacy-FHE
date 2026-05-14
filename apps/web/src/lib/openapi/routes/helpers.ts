/**
 * Per-operation response builders.
 *
 * Every route file composes its full `responses` map from one of the
 * helpers below, so the spec stays consistent: public routes always
 * carry rate-limit headers and the full public error surface, internal
 * routes carry the internal error surface, and so on. The helper keeps
 * the call sites short and makes a forgotten 401 impossible — the
 * response type forces the caller to pass a description for the 2xx
 * success case and gets the entire error set for free.
 */

import type { ZodTypeAny } from 'zod';
import { errorResponses, privateResponseHeaders, publicResponseHeaders } from '../common';

type SuccessArgs = {
  status: number;
  description: string;
  schema: ZodTypeAny;
};

/**
 * Public route response set: 2xx success with rate-limit headers, plus
 * the full public error surface. 204 / 205 / 304 responses (no body)
 * should use `publicNoContentResponses` instead.
 */
export function publicResponses({ status, description, schema }: SuccessArgs) {
  return {
    [status]: {
      description,
      content: { 'application/json': { schema } },
      headers: publicResponseHeaders,
    },
    ...errorResponses.publicStandard,
  } as const;
}

/** Public route with a 204 success — delete / cancel operations. */
export function publicNoContentResponses(description = 'No content.') {
  return {
    204: {
      description,
      headers: publicResponseHeaders,
    },
    ...errorResponses.publicStandard,
  } as const;
}

/** Internal (dashboard) route response set. */
export function internalResponses({ status, description, schema }: SuccessArgs) {
  return {
    [status]: {
      description,
      content: { 'application/json': { schema } },
      headers: privateResponseHeaders,
    },
    ...errorResponses.internalStandard,
  } as const;
}

export function internalNoContentResponses(description = 'No content.') {
  return {
    204: {
      description,
      headers: privateResponseHeaders,
    },
    ...errorResponses.internalStandard,
  } as const;
}

/** Admin route response set. */
export function adminResponses({ status, description, schema }: SuccessArgs) {
  return {
    [status]: {
      description,
      content: { 'application/json': { schema } },
      headers: privateResponseHeaders,
    },
    ...errorResponses.adminStandard,
  } as const;
}

export function adminNoContentResponses(description = 'No content.') {
  return {
    204: {
      description,
      headers: privateResponseHeaders,
    },
    ...errorResponses.adminStandard,
  } as const;
}

/** Inbound webhook route response set (Didit). */
export function inboundWebhookResponses({ status, description, schema }: SuccessArgs) {
  return {
    [status]: {
      description,
      content: { 'application/json': { schema } },
      headers: privateResponseHeaders,
    },
    ...errorResponses.inboundWebhookStandard,
  } as const;
}

/** Public health / status route response set — unauthenticated, minimal error surface. */
export function healthResponses({ status, description, schema }: SuccessArgs) {
  return {
    [status]: {
      description,
      content: { 'application/json': { schema } },
      headers: privateResponseHeaders,
    },
    ...errorResponses.healthStandard,
  } as const;
}
