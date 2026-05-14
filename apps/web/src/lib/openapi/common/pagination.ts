/**
 * Cursor pagination — every list endpoint returns `{ data, pagination }`
 * where `pagination.nextCursor` is null on the final page.
 *
 * The cursor is opaque to callers (an opaque base64url blob); the server
 * decides how to encode it. Offset pagination is intentionally not
 * supported: at the volumes we expect (millions of usage events, tens of
 * thousands of credentials per firm) offset queries degrade quickly on
 * the index scan, whereas a keyset cursor stays O(1) regardless of page.
 */

import { registry, z } from '../registry';
import { PaginationCursor } from './primitives';

/**
 * Page size bounds. `1..100` is the same window the database enforces
 * via the `limit` parameter in the service layer (PLAN.md step 10).
 * The default of `25` matches the dashboard's default list size so the
 * interactive playground never has to override.
 */
export const PaginationLimit = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(25)
  .openapi('PaginationLimit', {
    description: 'Page size. Must be in `[1, 100]`, defaults to 25.',
    example: 25,
  });

export type PaginationLimit = z.infer<typeof PaginationLimit>;

/**
 * Query parameters accepted by every list endpoint. `cursor` is optional
 * on the first page and always present on subsequent pages (it is the
 * token returned by the previous response).
 */
export const PaginationQuery = z
  .object({
    cursor: PaginationCursor.optional().openapi({
      param: { name: 'cursor', in: 'query' },
    }),
    limit: PaginationLimit.optional().openapi({
      param: { name: 'limit', in: 'query' },
    }),
  })
  .openapi('PaginationQuery', {
    description: 'Query parameters shared by every list endpoint.',
  });

export type PaginationQuery = z.infer<typeof PaginationQuery>;

/**
 * Response envelope: `{ data: Item[], pagination: { nextCursor, limit } }`.
 * Matches `Paginated<T>` in `@crivacy/shared-types`. `nextCursor` is
 * `null` when the current page is terminal.
 *
 * Note: we deliberately do not expose a `total` count. Returning totals
 * on cursor-paginated endpoints forces a second COUNT(*) query that is
 * wasted work for most callers and becomes prohibitively expensive at
 * scale; callers that really need a total can call the aggregate endpoint
 * that is purpose-built for it.
 */
export function paginated<ItemSchema extends z.ZodTypeAny>(itemSchema: ItemSchema) {
  return z
    .object({
      data: z.array(itemSchema),
      pagination: z.object({
        nextCursor: PaginationCursor.nullable().openapi({
          description: '`null` when the current page is the last.',
        }),
        limit: z.number().int().min(1).max(100),
      }),
    })
    .openapi({
      description: 'Cursor-paginated envelope.',
    });
}

/**
 * Component-registered empty envelope used by tests and documentation to
 * assert the paginated shape exists in the generated spec.
 */
export const PaginationEnvelopeMarker = z
  .object({
    data: z.array(z.unknown()),
    pagination: z.object({
      nextCursor: PaginationCursor.nullable(),
      limit: z.number().int().min(1).max(100),
    }),
  })
  .openapi('PaginationEnvelope', {
    description:
      'Shape of a cursor-paginated response envelope. The concrete `data` item type is substituted per endpoint.',
  });

registry.register('PaginationEnvelope', PaginationEnvelopeMarker);
