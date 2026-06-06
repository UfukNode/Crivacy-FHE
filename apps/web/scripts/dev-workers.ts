/**
 * Standalone dev-mode worker process — runs alongside `pnpm dev`.
 *
 * Why this exists:
 *
 *   `instrumentation.ts` registers pg-boss workers via dynamic imports
 *   marked `webpackIgnore: true`. Those directives are required because
 *   OpenTelemetry gRPC + grpc-js + pg-boss reach for Node.js built-ins
 *   (`fs`, `http2`, `stream`) that webpack cannot bundle. The directive
 *   works perfectly in `next build && next start` (production mode —
 *   the bundle output puts everything in matching paths and Node ESM
 *   resolves them at runtime).
 *
 *   In `next dev`, however, Turbopack/webpack emits the compiled
 *   instrumentation.js at a depth that doesn't line up with the
 *   relative paths in the source — `./server/jobs/queue` resolves to
 *   `.next/server/server/jobs/queue` and Node ESM throws
 *   `Cannot find module`. Removing webpackIgnore swaps that error for
 *   the gRPC `Cannot resolve 'fs'` bundling failure. There is no
 *   webpackIgnore + dev-path combo that satisfies both.
 *
 *   Sector-standard answer: separate the worker process from the web
 *   server. Stripe / Plaid / Persona run web dynos and worker dynos
 *   independently in production; mirroring that split for dev means
 *   `pnpm dev` runs Next without instrumentation workers and this
 *   script runs as a standalone Node process that imports + starts
 *   the same worker registrations the production instrumentation
 *   would have started.
 *
 * Usage (two terminals):
 *
 *   Terminal 1: `pnpm dev`
 *   Terminal 2: `pnpm dev:workers`
 *
 *   Both processes connect to the same Postgres + pg-boss tables, so
 *   any webhook or API call that lands an `enqueueCredentialPipeline`
 *   from the dev server is picked up by this process within seconds
 *   and the mint TX submits + customer kyc_level bumps just like
 *   production. Works for the LAN handoff flow, OAuth callbacks,
 *   webhook fan-out, KYC reconciler — every queue.
 *
 * Lifecycle:
 *   - SIGINT (Ctrl-C) / SIGTERM — gracefully stops every pg-boss
 *     instance so in-flight jobs aren't left dangling.
 *   - On any worker `init` failure the script keeps running; other
 *     workers stay up. The error is logged so the developer can
 *     diagnose without losing the rest of the queue coverage.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createQueueClient } from '@/server/jobs/queue';
import { registerCredentialPipelineWorker } from '@/server/jobs/credential-pipeline-worker';
import { registerCredentialExpireWorker } from '@/server/jobs/credential-expire-worker';
import { registerWebhookWorker } from '@/server/jobs/webhook-worker';
import { buildWorkerRepository } from '@/server/jobs/webhook-repository';
import { registerEmailWorker } from '@/server/jobs/email-worker';
import { registerSessionCleanupWorker } from '@/server/jobs/session-cleanup-worker';
import { registerSecurityEventsWorker } from '@/server/jobs/security-events-worker';
import { registerIdempotencySweeperWorker } from '@/server/jobs/idempotency-sweeper-worker';
import { registerKycReconcilerWorker } from '@/server/jobs/kyc-reconciler-worker';
import { registerIpAbusePrunerWorker } from '@/server/jobs/ip-abuse-pruner-worker';
import { getDatabaseClient } from '@/lib/db/client';
import { getWebhookConfig } from '@/lib/webhook/config';
import { buildEmailConfig } from '@/lib/email/config';

function loadEnv(path: string): void {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

interface WorkerLogger {
  readonly info: (msg: string, meta?: Record<string, unknown>) => void;
  readonly error: (msg: string, meta?: Record<string, unknown>) => void;
}

function makeConsoleLogger(): WorkerLogger {
  return {
    info: (msg, meta): void => {
      if (meta !== undefined && Object.keys(meta).length > 0) {
        console.info(`[dev-workers] ${msg}`, meta);
      } else {
        console.info(`[dev-workers] ${msg}`);
      }
    },
    error: (msg, meta): void => {
      if (meta !== undefined && Object.keys(meta).length > 0) {
        console.error(`[dev-workers] ${msg}`, meta);
      } else {
        console.error(`[dev-workers] ${msg}`);
      }
    },
  };
}

const stops: Array<() => Promise<void>> = [];

async function safeStart(
  name: string,
  logger: WorkerLogger,
  fn: () => Promise<() => Promise<void>>,
): Promise<void> {
  try {
    const stop = await fn();
    stops.push(async () => {
      try {
        await stop();
        logger.info(`${name} stopped`);
      } catch (err) {
        logger.error(`${name} stop failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    logger.info(`${name} registered`);
  } catch (err) {
    logger.error(`${name} init failed (other workers continue)`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  loadEnv(resolve(here, '../.env'));
  loadEnv(resolve(here, '../.env.local'));

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    console.error('DATABASE_URL is not set. Cannot start workers.');
    process.exit(1);
  }

  const logger = makeConsoleLogger();
  const { db } = getDatabaseClient();

  logger.info('starting dev worker process', { pid: process.pid });

  // Each worker gets its own boss instance — same shape the production
  // `instrumentation.ts` uses. pg-boss is happy with multiple clients
  // pointing at the same schema; per-queue registration prevents one
  // worker's start failure from cascading into the others.
  await safeStart('credential-pipeline', logger, async () => {
    const boss = await createQueueClient(connectionString);
    await registerCredentialPipelineWorker(boss, { db, logger });
    return async () => {
      await boss.stop();
    };
  });

  await safeStart('credential-expire', logger, async () => {
    const boss = await createQueueClient(connectionString);
    await registerCredentialExpireWorker(boss, { db, logger });
    return async () => {
      await boss.stop();
    };
  });

  await safeStart('webhook-delivery', logger, async () => {
    const boss = await createQueueClient(connectionString);
    const repo = buildWorkerRepository();
    const cfg = getWebhookConfig();
    await registerWebhookWorker(boss, { db, config: cfg }, repo);
    return async () => {
      await boss.stop();
    };
  });

  await safeStart('email', logger, async () => {
    const boss = await createQueueClient(connectionString);
    const cfg = buildEmailConfig(process.env as Record<string, string | undefined>);
    await registerEmailWorker(boss, { config: cfg, logger });
    return async () => {
      await boss.stop();
    };
  });

  await safeStart('session-cleanup', logger, async () => {
    const boss = await createQueueClient(connectionString);
    await registerSessionCleanupWorker(boss, { db, logger });
    return async () => {
      await boss.stop();
    };
  });

  await safeStart('security-events', logger, async () => {
    const boss = await createQueueClient(connectionString);
    await registerSecurityEventsWorker(boss, { db, logger });
    return async () => {
      await boss.stop();
    };
  });

  await safeStart('idempotency-sweeper', logger, async () => {
    const boss = await createQueueClient(connectionString);
    await registerIdempotencySweeperWorker(boss, { db, logger });
    return async () => {
      await boss.stop();
    };
  });

  await safeStart('kyc-reconciler', logger, async () => {
    const boss = await createQueueClient(connectionString);
    await registerKycReconcilerWorker(boss, { db, logger });
    return async () => {
      await boss.stop();
    };
  });

  await safeStart('ip-abuse-pruner', logger, async () => {
    const boss = await createQueueClient(connectionString);
    await registerIpAbusePrunerWorker(boss, { db, logger });
    return async () => {
      await boss.stop();
    };
  });

  logger.info(`ready — ${stops.length} worker(s) running. Ctrl-C to stop.`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received, stopping workers...`);
    await Promise.allSettled(stops.map((s) => s()));
    logger.info('all workers stopped, exiting');
    process.exit(0);
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

void main().catch((err) => {
  console.error('[dev-workers] fatal:', err);
  process.exit(1);
});
