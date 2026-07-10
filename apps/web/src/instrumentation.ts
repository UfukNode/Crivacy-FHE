/**
 * Next.js instrumentation hook.
 *
 * Called once when the Next.js server starts. Initializes:
 *   - OpenTelemetry SDK (if OTEL_ENABLED=true)
 *   - Default Prometheus metrics (node.js runtime metrics)
 *   - Root pino logger
 *   - pg-boss workers (credential-pipeline, email-send, session-cleanup)
 *
 * All dynamic imports use `webpackIgnore: true` so webpack does not
 * attempt to bundle Node.js-only packages (OTel, gRPC, pino,
 * prom-client, pg-boss) during dev compilation. At runtime in
 * production standalone mode Node.js resolves them normally.
 *
 * In dev mode, workers are not started here. Email sending falls back
 * to direct SMTP delivery (see `enqueueEmailFromRoute`).
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 * @module
 */

type WorkerLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
};

export async function register(): Promise<void> {
  // Only run on the server
  if (typeof window !== 'undefined') return;

  // Each worker registers its own SIGTERM/SIGINT shutdown hook; with 9
  // workers plus the OTel SDK that's 11+ listeners on `process`, well
  // over Node's default `MaxListeners=10` warning threshold. The bound
  // is bumped once here so the warning never reaches the Next dev
  // overlay (intercepted by `intercept-console-error`).
  if (typeof process.setMaxListeners === 'function') {
    process.setMaxListeners(Math.max(process.getMaxListeners(), 30));
  }

  // prom-client (cluster), OTel gRPC (stream, http2), and pino require
  // Node.js built-ins that webpack cannot bundle during `next dev`.
  // All observability and worker initialisation is deferred to production
  // standalone. In dev, emails are sent directly via nodemailer (no worker).
  //
  // Sprint 7 Phase K — `RUN_WORKERS_IN_DEV=1` opt-in lets a developer
  // reproduce production worker behaviour locally without a `next
  // build` round-trip. The webpackIgnore-marked dynamic imports are
  // already prepared for it; the only thing the dev mode skipped was
  // the `register()` invocation. With this gate flipped, any stuck-
  // customer mint (and reconciler / webhook delivery / etc.) can be
  // reproduced inside a `pnpm dev` Turbopack process.
  const runWorkersInDev = process.env['RUN_WORKERS_IN_DEV'] === '1';
  if (process.env.NODE_ENV !== 'production' && !runWorkersInDev) {
    console.info(
      '[instrumentation] dev mode — observability + workers skipped (set RUN_WORKERS_IN_DEV=1 to enable)',
    );
    return;
  }
  if (process.env.NODE_ENV !== 'production' && runWorkersInDev) {
    console.info(
      '[instrumentation] dev mode + RUN_WORKERS_IN_DEV=1 — workers WILL start in this process',
    );
  }

  try {
    const { initTracing } = await import(/* webpackIgnore: true */ './lib/observability/tracing');
    const { initDefaultMetrics } = await import(/* webpackIgnore: true */ './lib/observability/metrics');
    const { getRootLogger } = await import(/* webpackIgnore: true */ './lib/observability/logger');

    await initTracing();
    initDefaultMetrics();

    const logger = getRootLogger();
    logger.info('Instrumentation initialized');

    // --- Workers ---
    await initCredentialPipelineWorker(logger);
    await initCredentialExpireWorker(logger);
    await initWebhookDeliveryWorker(logger);
    await initEmailWorker(logger);
    await initSessionCleanupWorker(logger);
    await initSecurityEventsWorker(logger);
    await initIdempotencySweeperWorker(logger);
    await initKycReconcilerWorker(logger);
    await initIpAbusePrunerWorker(logger);
    await initFirmGrantWorker(logger);
  } catch (err) {
    // Non-fatal — the API still works, just without metrics/traces/structured logs.
    console.warn('[instrumentation] init failed, skipping:', err);
  }
}

/**
 * Start the credential-pipeline pg-boss worker. This worker mints chain
 * credentials after a customer's Didit KYC session is approved. The
 * pg-boss instance is created from DATABASE_URL and the worker is
 * registered with `batchSize: 1` to process jobs sequentially.
 *
 * Follows the same DI pattern as `email-worker.ts`: the worker handler
 * receives a deps object with a `CrivacyDatabase` and a logger, keeping
 * the handler itself testable without real infrastructure.
 */
async function initCredentialPipelineWorker(logger: WorkerLogger): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    logger.info('DATABASE_URL not set — credential-pipeline worker not started');
    return;
  }

  try {
    const { createQueueClient } = await import(/* webpackIgnore: true */ './server/jobs/queue');
    const { registerCredentialPipelineWorker } = await import(/* webpackIgnore: true */      './server/jobs/credential-pipeline-worker'
    );
    const { getDatabaseClient } = await import(/* webpackIgnore: true */ './lib/db/client');

    const boss = await createQueueClient(connectionString);
    const { db } = getDatabaseClient();

    await registerCredentialPipelineWorker(boss, { db, logger });
    logger.info('Credential pipeline worker registered');

    // Graceful shutdown: stop the boss instance when the process exits
    const shutdown = async (): Promise<void> => {
      try {
        await boss.stop();
        logger.info('Credential pipeline pg-boss stopped');
      } catch (stopErr) {
        logger.error('Credential pipeline pg-boss stop failed', {
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    };

    process.once('SIGTERM', () => {
      void shutdown();
    });
    process.once('SIGINT', () => {
      void shutdown();
    });
  } catch (err) {
    // Non-fatal — the webhook can still enqueue jobs; they will be
    // processed when the worker starts successfully on the next deploy.
    logger.error('Credential pipeline worker init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the credential-expire pg-boss worker. Hourly cron sweeps
 * `kyc_credentials_meta` rows whose `valid_until` has passed but
 * are still `status='active'`, flips each to `expired`, and
 * emits a `credential.expired` webhook to the issuing firm.
 * Closes PROD-TODO blocker #1.
 */
async function initCredentialExpireWorker(logger: WorkerLogger): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    logger.info('DATABASE_URL not set — credential-expire worker not started');
    return;
  }

  try {
    const { createQueueClient } = await import(/* webpackIgnore: true */ './server/jobs/queue');
    const { registerCredentialExpireWorker } = await import(/* webpackIgnore: true */      './server/jobs/credential-expire-worker'
    );
    const { getDatabaseClient } = await import(/* webpackIgnore: true */ './lib/db/client');

    const boss = await createQueueClient(connectionString);
    const { db } = getDatabaseClient();

    await registerCredentialExpireWorker(boss, { db, logger });
    logger.info('Credential expire worker registered (hourly cron)');

    const shutdown = async (): Promise<void> => {
      try {
        await boss.stop();
        logger.info('Credential expire pg-boss stopped');
      } catch (stopErr) {
        logger.error('Credential expire pg-boss stop failed', {
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    };

    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
  } catch (err) {
    // Non-fatal — TTL expiry processing pauses until the next
    // deploy that brings the worker up successfully.
    logger.error('Credential expire worker init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the webhook delivery pg-boss worker. Processes
 * `webhook-delivery` jobs by issuing the outbound HTTP POST with
 * HMAC-signed body, recording the response, and updating the
 * delivery row's status / circuit breaker. The job is enqueued
 * by `emit*Event` helpers when a domain event fans out to a
 * subscribed endpoint.
 *
 * Previously the worker was exported but never wired here, so
 * deliveries piled up in the queue waiting for a consumer that
 * never started. This bridges that gap.
 */
async function initWebhookDeliveryWorker(logger: WorkerLogger): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    logger.info('DATABASE_URL not set — webhook delivery worker not started');
    return;
  }

  try {
    const { createQueueClient } = await import(/* webpackIgnore: true */ './server/jobs/queue');
    const { registerWebhookWorker } = await import(/* webpackIgnore: true */      './server/jobs/webhook-worker'
    );
    const { buildWorkerRepository } = await import(/* webpackIgnore: true */      './server/jobs/webhook-repository'
    );
    const { getDatabaseClient } = await import(/* webpackIgnore: true */ './lib/db/client');
    const { getWebhookConfig } = await import(/* webpackIgnore: true */ './lib/webhook/config');

    const boss = await createQueueClient(connectionString);
    const { db } = getDatabaseClient();
    const config = getWebhookConfig();
    const repo = buildWorkerRepository();

    await registerWebhookWorker(boss, { db, config }, repo);
    logger.info('Webhook delivery worker registered', { concurrency: config.concurrency });

    const shutdown = async (): Promise<void> => {
      try {
        await boss.stop();
        logger.info('Webhook delivery pg-boss stopped');
      } catch (stopErr) {
        logger.error('Webhook delivery pg-boss stop failed', {
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    };

    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
  } catch (err) {
    // Non-fatal — emit*Event still enqueues jobs successfully;
    // they queue up until the next deploy that brings the worker
    // up. Better to ship the API than to fail-stop the boot on
    // a transient pg-boss connection issue.
    logger.error('Webhook delivery worker init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the email-send pg-boss worker. Processes email-send jobs by
 * calling nodemailer with the job payload. Runs alongside the
 * credential pipeline worker in the same process.
 */
async function initEmailWorker(logger: WorkerLogger): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  const smtpHost = process.env['SMTP_HOST'];

  if (!connectionString || !smtpHost) {
    logger.info('DATABASE_URL or SMTP_HOST not set — email worker not started');
    return;
  }

  try {
    const { createQueueClient } = await import(/* webpackIgnore: true */ './server/jobs/queue');
    const { registerEmailWorker } = await import(/* webpackIgnore: true */ './server/jobs/email-worker');
    const { buildEmailConfig } = await import(/* webpackIgnore: true */ './lib/email/config');

    const config = buildEmailConfig(process.env as Record<string, string | undefined>);
    const boss = await createQueueClient(connectionString);

    await registerEmailWorker(boss, { config, logger });
    logger.info('Email worker registered');

    const shutdown = async (): Promise<void> => {
      try {
        await boss.stop();
        logger.info('Email pg-boss stopped');
      } catch (stopErr) {
        logger.error('Email pg-boss stop failed', {
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    };

    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
  } catch (err) {
    logger.error('Email worker init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the session-cleanup pg-boss worker. Periodically deletes
 * expired session rows from both `sessions` and `customer_sessions`
 * tables to prevent unbounded table growth.
 */
async function initSessionCleanupWorker(logger: WorkerLogger): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    logger.info('DATABASE_URL not set — session cleanup worker not started');
    return;
  }

  try {
    const { createQueueClient } = await import(/* webpackIgnore: true */ './server/jobs/queue');
    const { registerSessionCleanupWorker } = await import(/* webpackIgnore: true */      './server/jobs/session-cleanup-worker'
    );
    const { getDatabaseClient } = await import(/* webpackIgnore: true */ './lib/db/client');

    const boss = await createQueueClient(connectionString);
    const { db } = getDatabaseClient();

    await registerSessionCleanupWorker(boss, { db, logger });
    logger.info('Session cleanup worker registered');

    const shutdown = async (): Promise<void> => {
      try {
        await boss.stop();
        logger.info('Session cleanup pg-boss stopped');
      } catch (stopErr) {
        logger.error('Session cleanup pg-boss stop failed', {
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    };

    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
  } catch (err) {
    logger.error('Session cleanup worker init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the security-events outbox worker. Drains the
 * `security_events_outbox` table on a 1-minute cron, fanning events
 * out to the registered subscribers (audit writer + notification
 * email dispatcher).
 *
 * This worker is LOAD-BEARING for the post-Phase-2 migration — every
 * state-changing settings endpoint now emits events into the outbox
 * inside its mutation transaction. If this worker never starts, the
 * audit trail stays empty and notification emails never leave the
 * server. Fail-loud on init errors so a misconfigured prod deploy is
 * obvious from the bootstrap logs.
 */
async function initSecurityEventsWorker(logger: WorkerLogger): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    logger.info('DATABASE_URL not set — security-events worker not started');
    return;
  }

  try {
    const { createQueueClient } = await import(/* webpackIgnore: true */ './server/jobs/queue');
    const { registerSecurityEventsWorker } = await import(/* webpackIgnore: true */      './server/jobs/security-events-worker'
    );
    const { getDatabaseClient } = await import(/* webpackIgnore: true */ './lib/db/client');

    const boss = await createQueueClient(connectionString);
    const { db } = getDatabaseClient();

    await registerSecurityEventsWorker(boss, { db, logger });
    logger.info('Security-events worker registered');

    const shutdown = async (): Promise<void> => {
      try {
        await boss.stop();
        logger.info('Security-events pg-boss stopped');
      } catch (stopErr) {
        logger.error('Security-events pg-boss stop failed', {
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    };

    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
  } catch (err) {
    logger.error('Security-events worker init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the KYC reconciler — periodic drift sweep that catches the
 * case where neither the Didit webhook (push) nor the SSE
 * pull-fallback landed, so a Didit-Approved verification never
 * reached the credential-pipeline. Every 15 min by default the
 * worker scans the audit log for `customer.kyc_started` events with
 * no completion event + no active credential, calls Didit live, and
 * re-routes through the same `enqueueCredentialPipeline` path the
 * webhook uses. The pipeline's existing 5-layer dedupe absorbs any
 * race with a late-arriving webhook.
 *
 * Kill-switch: set `KYC_RECONCILER_DISABLE=true` to keep the worker
 * from registering at all (used during initial roll-out).
 */
async function initKycReconcilerWorker(logger: WorkerLogger): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    logger.info('DATABASE_URL not set — kyc-reconciler worker not started');
    return;
  }

  try {
    const { createQueueClient } = await import(/* webpackIgnore: true */ './server/jobs/queue');
    const { registerKycReconcilerWorker } = await import(/* webpackIgnore: true */      './server/jobs/kyc-reconciler-worker'
    );
    const { getDatabaseClient } = await import(/* webpackIgnore: true */ './lib/db/client');

    const boss = await createQueueClient(connectionString);
    const { db } = getDatabaseClient();

    await registerKycReconcilerWorker(boss, { db, logger });

    const shutdown = async (): Promise<void> => {
      try {
        await boss.stop();
        logger.info('Kyc reconciler pg-boss stopped');
      } catch (stopErr) {
        logger.error('Kyc reconciler pg-boss stop failed', {
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    };

    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
  } catch (err) {
    // Non-fatal — webhooks + pull-fallback still run; the reconciler
    // is the safety net, so a missing reconciler does not block any
    // active customer flow. Operator catches the warning in logs.
    logger.error('Kyc reconciler worker init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the idempotency-keys sweeper. Periodically deletes rows past
 * their `expires_at` window so the `idempotency_keys` table stays
 * bounded.
 */
async function initIdempotencySweeperWorker(logger: WorkerLogger): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    logger.info('DATABASE_URL not set — idempotency sweeper not started');
    return;
  }

  try {
    const { createQueueClient } = await import(/* webpackIgnore: true */ './server/jobs/queue');
    const { registerIdempotencySweeperWorker } = await import(/* webpackIgnore: true */      './server/jobs/idempotency-sweeper-worker'
    );
    const { getDatabaseClient } = await import(/* webpackIgnore: true */ './lib/db/client');

    const boss = await createQueueClient(connectionString);
    const { db } = getDatabaseClient();

    await registerIdempotencySweeperWorker(boss, { db, logger });
    logger.info('Idempotency sweeper worker registered');

    const shutdown = async (): Promise<void> => {
      try {
        await boss.stop();
        logger.info('Idempotency sweeper pg-boss stopped');
      } catch (stopErr) {
        logger.error('Idempotency sweeper pg-boss stop failed', {
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    };

    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
  } catch (err) {
    logger.error('Idempotency sweeper init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the IP-abuse-signals pruner (Sprint 6). Daily DELETE of rows
 * past the 7-day TTL window. Independent of the IP-abuse counter
 * itself — readers already filter by `last_seen >= cutoff`, so this
 * is storage hygiene, not a correctness gate.
 */
/**
 * Start the firm access-grant worker. Every-minute cron sweep drains
 * `firm_credential_grants` rows the OAuth consent handler wrote and calls the
 * on-chain `grantAccess(user, firm, minLevel)` so a relying firm can decrypt
 * the encrypted eligibility verdict for a consenting user. The ~15s tx runs
 * here, off the consent request path.
 */
async function initFirmGrantWorker(logger: WorkerLogger): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    logger.info('DATABASE_URL not set — firm-grant worker not started');
    return;
  }

  try {
    const { createQueueClient } = await import(/* webpackIgnore: true */ './server/jobs/queue');
    const { registerFirmGrantWorker } = await import(/* webpackIgnore: true */      './server/jobs/firm-grant-worker'
    );
    const { getDatabaseClient } = await import(/* webpackIgnore: true */ './lib/db/client');

    const boss = await createQueueClient(connectionString);
    const { db } = getDatabaseClient();

    await registerFirmGrantWorker(boss, { db, logger });
    logger.info('Firm access-grant worker registered (1-min cron)');

    const shutdown = async (): Promise<void> => {
      try {
        await boss.stop();
        logger.info('Firm access-grant pg-boss stopped');
      } catch (stopErr) {
        logger.error('Firm access-grant pg-boss stop failed', {
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    };

    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
  } catch (err) {
    // Non-fatal — the consent handler still records pending grant rows;
    // they drain on the next deploy that brings the worker up.
    logger.error('Firm access-grant worker init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function initIpAbusePrunerWorker(logger: WorkerLogger): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    logger.info('DATABASE_URL not set — IP abuse pruner not started');
    return;
  }

  try {
    const { createQueueClient } = await import(/* webpackIgnore: true */ './server/jobs/queue');
    const { registerIpAbusePrunerWorker } = await import(/* webpackIgnore: true */      './server/jobs/ip-abuse-pruner-worker'
    );
    const { getDatabaseClient } = await import(/* webpackIgnore: true */ './lib/db/client');

    const boss = await createQueueClient(connectionString);
    const { db } = getDatabaseClient();

    await registerIpAbusePrunerWorker(boss, { db, logger });
    logger.info('IP abuse pruner worker registered');

    const shutdown = async (): Promise<void> => {
      try {
        await boss.stop();
        logger.info('IP abuse pruner pg-boss stopped');
      } catch (stopErr) {
        logger.error('IP abuse pruner pg-boss stop failed', {
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    };

    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
  } catch (err) {
    logger.error('IP abuse pruner init failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
