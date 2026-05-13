/**
 * Admin-only system health / queue inspection schemas.
 */

import { DateTimeIso } from '../common/primitives';
import { z } from '../registry';

export const AdminSystemMetricsResponse = z
  .object({
    at: DateTimeIso,
    db: z.object({
      poolSize: z.number().int().min(0),
      poolIdle: z.number().int().min(0),
      poolWaiting: z.number().int().min(0),
      slowQueriesLastMin: z.number().int().min(0),
    }),
    chain: z.object({
      reachable: z.boolean(),
      operatorOk: z.boolean(),
      lastTxAt: DateTimeIso.nullable(),
    }),
    didit: z.object({
      reachable: z.boolean(),
      last5xxAt: DateTimeIso.nullable(),
      sessionsCreated24h: z.number().int().min(0),
      sessionsApproved24h: z.number().int().min(0),
    }),
    httpRequestsLastMin: z.number().int().min(0),
    errorRateLastMin: z.number().min(0).max(1),
  })
  .openapi('AdminSystemMetricsResponse', {
    description: 'Live internal health counters for the admin dashboard.',
  });
export type AdminSystemMetricsResponse = z.infer<typeof AdminSystemMetricsResponse>;

export const AdminQueueStat = z
  .object({
    name: z.string().min(1).max(64),
    pending: z.number().int().min(0),
    active: z.number().int().min(0),
    completedLastHour: z.number().int().min(0),
    failedLastHour: z.number().int().min(0),
    oldestPendingAt: DateTimeIso.nullable(),
  })
  .openapi('AdminQueueStat', {
    description: 'Single pg-boss queue state snapshot.',
  });
export type AdminQueueStat = z.infer<typeof AdminQueueStat>;

export const AdminQueuesResponse = z
  .object({
    queues: z.array(AdminQueueStat),
  })
  .openapi('AdminQueuesResponse', {
    description: 'Response for `GET /api/admin/system/queues`.',
  });
export type AdminQueuesResponse = z.infer<typeof AdminQueuesResponse>;
