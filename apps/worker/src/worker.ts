import { DelayedError, UnrecoverableError, Worker } from 'bullmq'
import type { ConnectionOptions, WorkerOptions } from 'bullmq'
import {
  QUEUE_NAME,
  createRedisClient,
  workerSettings,
  type DeliveryJobData
} from '@vitrine/queue'
import { createDbClient, type DbClient } from '@vitrine/db'
import pino from 'pino'
import type { Logger, LoggerOptions } from 'pino'
import type { Redis } from 'ioredis'
import { deliver } from './deliver'

export interface StartWorkerOptions {
  db?: DbClient
  redis?: Redis | ConnectionOptions
  masterKey: Buffer
  logger?: Logger | LoggerOptions
}

function isLogger(value: Logger | LoggerOptions | undefined): value is Logger {
  return typeof value === 'object' && value !== null && typeof (value as Logger).child === 'function'
}

function isRedisInstance(value: Redis | ConnectionOptions | undefined): value is Redis {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Redis).duplicate === 'function' &&
    typeof (value as Redis).status === 'string'
  )
}

export async function startWorker(opts: StartWorkerOptions): Promise<Worker<DeliveryJobData>> {
  const logger: Logger = isLogger(opts.logger) ? opts.logger : pino(opts.logger ?? {})
  const db = opts.db ?? createDbClient(process.env.DATABASE_URL ?? '')
  const redis: Redis = isRedisInstance(opts.redis)
    ? opts.redis
    : createRedisClient(process.env.REDIS_URL ?? '')

  const worker = new Worker<DeliveryJobData>(
    QUEUE_NAME,
    async (job, token) => {
      const result = await deliver({ db, redis, masterKey: opts.masterKey, logger }, job)

      if (result.kind === 'success') return

      if (result.kind === 'breaker_skip') {
        // Move to delayed and signal BullMQ via DelayedError so the throw is not
        // counted as a failed attempt.
        await job.moveToDelayed(Date.now() + result.remainingMs, token)
        throw new DelayedError(`breaker_open:retry_in_${result.remainingMs}ms`)
      }

      if (result.kind === 'dlq') {
        // UnrecoverableError tells BullMQ to mark the job as failed permanently
        // regardless of remaining attempts.
        throw new UnrecoverableError(`terminal:${result.reason}`)
      }

      // retry
      if (result.delayOverrideMs !== undefined) {
        // Throttle override (e.g. 429 Retry-After). Same DelayedError trick:
        // the moveToDelayed call wins, the throw doesn't burn an attempt.
        await job.moveToDelayed(Date.now() + result.delayOverrideMs, token)
        throw new DelayedError(`retry:${result.reason}:override_${result.delayOverrideMs}ms`)
      }

      // Normal retry: throw, BullMQ honours `attempts` + custom backoff strategy.
      throw new Error(`retry:${result.reason}`)
    },
    {
      connection: redis,
      concurrency: 10,
      settings: workerSettings() as NonNullable<WorkerOptions['settings']>
    }
  )

  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, err: err.message }, 'job failed')
  })

  return worker
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const masterKeyEnv = process.env.MASTER_ENCRYPTION_KEY
  if (!masterKeyEnv) throw new Error('MASTER_ENCRYPTION_KEY is required')
  const masterKey = Buffer.from(masterKeyEnv, 'base64')
  await startWorker({ masterKey, logger: { level: process.env.LOG_LEVEL ?? 'info' } })
}
