/**
 * Playground proxy schemas. `POST /api/internal/playground/execute`
 * lets a dashboard user send a real request to the public API against
 * one of their test-mode API keys, without ever disclosing the key to
 * the browser.
 *
 * The response echoes the backing public-API call's status, headers and
 * body verbatim — but with the rate-limit headers stripped to avoid
 * confusing the caller (dashboard uses a different rate bucket).
 */

import { z } from '../registry';
import { ApiKeyId } from './identifiers';

export const PlaygroundMethod = z
  .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  .openapi('PlaygroundMethod', {
    description: 'HTTP method the playground will invoke.',
  });
export type PlaygroundMethod = z.infer<typeof PlaygroundMethod>;

export const PlaygroundExecuteRequest = z
  .object({
    apiKeyId: ApiKeyId.openapi({
      description: 'The test-mode API key id to execute the request under.',
    }),
    method: PlaygroundMethod,
    path: z
      .string()
      .regex(/^\/api\/v1\/[A-Za-z0-9/_-]+$/, {
        message: 'Path must start with `/api/v1/` and contain only URL-safe characters.',
      })
      .max(256)
      .openapi({
        description: 'Request path, must start with `/api/v1/`.',
        example: '/api/v1/sessions',
      }),
    query: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
  })
  .openapi('PlaygroundExecuteRequest', {
    description: 'Payload for `POST /api/internal/playground/execute`.',
  });
export type PlaygroundExecuteRequest = z.infer<typeof PlaygroundExecuteRequest>;

export const PlaygroundExecuteResponse = z
  .object({
    statusCode: z.number().int().min(100).max(599),
    latencyMs: z.number().int().min(0),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
  })
  .openapi('PlaygroundExecuteResponse', {
    description: 'Response for `POST /api/internal/playground/execute`.',
  });
export type PlaygroundExecuteResponse = z.infer<typeof PlaygroundExecuteResponse>;
