import { getMaxAttempts } from '@vitrine/core'
import { events, type DbClient, createDbClient } from '@vitrine/db'
import { type DeliveryJobData, QUEUE_NAME, createRedisClient, workerSettings } from '@vitrine/queue'
// ============================================================================
//  worker.ts — The BullMQ CONSUMER: takes jobs, calls deliver(), and
//  turns the decision into CONTROL of BullMQ retries. ⭐ The DelayedError trick.
// ============================================================================
import { DelayedError, UnrecoverableError, Worker } from 'bullmq'
import type { WorkerOptions } from 'bullmq'
import { and, eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import pino from 'pino'
import type { Logger } from 'pino'
import { deliver } from './deliver'

export interface StartWorkerOptions {
  db?: DbClient
  redis?: Redis
  masterKey: Buffer
  logger?: Logger
}

export async function startWorker(opts: StartWorkerOptions): Promise<Worker<DeliveryJobData>> {
  // We ONLY accept ready-made (injected) instances; otherwise we build the
  // defaults. No more type guards: dependencies are built at the edge.
  const logger = opts.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' })
  const db = opts.db ?? createDbClient(process.env.DATABASE_URL ?? '')
  const redis = opts.redis ?? createRedisClient(process.env.REDIS_URL ?? '')

  const worker = new Worker<DeliveryJobData>(
    QUEUE_NAME,
    // The "processor": called for EACH job. `token` is used by moveToDelayed.
    async (job, token) => {
      const result = await deliver({ db, redis, masterKey: opts.masterKey, logger }, job)

      // success → throw nothing: BullMQ marks the job as completed.
      if (result.kind === 'success') return

      // ⭐ breaker_skip → POSTPONE the job WITHOUT consuming an attempt.
      // moveToDelayed reschedules; DelayedError tells BullMQ "this is a delay,
      // not a failure" → it does NOT burn one of the 7 attempts.
      if (result.kind === 'breaker_skip') {
        await job.moveToDelayed(Date.now() + result.remainingMs, token)
        throw new DelayedError(`breaker_open:retry_in_${result.remainingMs}ms`)
      }

      // dlq → PERMANENT failure (UnrecoverableError skips the remaining attempts).
      if (result.kind === 'dlq') {
        throw new UnrecoverableError(`terminal:${result.reason}`)
      }

      // retry with override (429 Retry-After) → same DelayedError trick (imposed
      // delay, without burning an attempt).
      // Consequence: an endpoint that ALWAYS answers 429 + Retry-After never
      // exhausts the 7 attempts; only the breaker slows it down.
      if (result.delayOverrideMs !== undefined) {
        await job.moveToDelayed(Date.now() + result.delayOverrideMs, token)
        throw new DelayedError(`retry:${result.reason}:override_${result.delayOverrideMs}ms`)
      }

      // NORMAL retry → throw an Error: BullMQ COUNTS the attempt and applies
      // our custom backoff (exponential delay + jitter).
      throw new Error(`retry:${result.reason}`)
    },
    {
      connection: redis,
      // I/O-bound work on one event loop: 10 requests in flight overlap their
      // network waits. Same number as the Postgres pool (max: 10 in db/client.ts),
      // and a job runs one query at a time, so jobs never wait for a connection.
      concurrency: 10, // up to 10 deliveries in parallel
      settings: workerSettings() as NonNullable<WorkerOptions['settings']>,
    },
  )

  // Safety net: when BullMQ has exhausted ALL attempts (5xx/network errors
  // that never produced a 4xx), mark the event "dead" here.
  // 'failed' fires after EVERY failed attempt (retries included), hence the
  // attemptsMade check below instead of trusting the event alone.
  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, err: err.message }, 'job failed')
    if (!job) return
    const maxAttempts = getMaxAttempts()
    if (job.attemptsMade >= maxAttempts) {
      void db
        .update(events)
        .set({ status: 'dead', deadAt: new Date() })
        // the `and(... status 'pending')` avoids overwriting an already delivered/dead event
        .where(and(eq(events.id, job.data.eventId), eq(events.status, 'pending')))
        .catch((dbErr) => {
          logger.error(
            { jobId: job.id, err: (dbErr as Error).message },
            'failed to mark event dead',
          )
        })
    }
  })

  return worker
}

// Direct launch (worker process): reads the master key from the env.
// No SIGTERM handler: `docker stop` kills the process with jobs in flight. Their
// lock expires, BullMQ's stalled-job check re-queues them, and the endpoint may
// receive those events twice. Calling `worker.close()` on SIGTERM (which waits
// for running jobs) would make deploys clean.
if (import.meta.url === `file://${process.argv[1]}`) {
  const masterKeyEnv = process.env.MASTER_ENCRYPTION_KEY
  if (!masterKeyEnv) throw new Error('MASTER_ENCRYPTION_KEY is required')
  const masterKey = Buffer.from(masterKeyEnv, 'base64')
  await startWorker({ masterKey, logger: pino({ level: process.env.LOG_LEVEL ?? 'info' }) })
}
