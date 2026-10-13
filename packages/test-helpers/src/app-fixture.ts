import { buildApp } from '../../../apps/api/src/server'
import { startWorker } from '../../../apps/worker/src/worker'
import { createDbClient } from '@vitrine/db'
import { createRedisClient } from '@vitrine/queue'
import pino from 'pino'
import type { FastifyInstance } from 'fastify'
import type { Worker } from 'bullmq'
import type { Redis } from 'ioredis'
import { randomBytes } from 'node:crypto'
import type { DbClient } from '@vitrine/db'

export interface AppFixture {
  app: FastifyInstance
  worker: Worker
  db: DbClient
  redis: Redis
  masterKey: Buffer
  baseUrl: string
  close: () => Promise<void>
}

export async function startApp(opts: {
  databaseUrl: string
  redisUrl: string
}): Promise<AppFixture> {
  const masterKey = randomBytes(32)
  // `buildApp` calls `loadConfigFromEnv()` when no `config` is passed, so we
  // need DATABASE_URL / REDIS_URL / MASTER_ENCRYPTION_KEY to be present in
  // process.env for the Zod parse to succeed. The fields we want to override
  // (db, redis, masterKey) are still passed explicitly via `opts`.
  process.env.DATABASE_URL = opts.databaseUrl
  process.env.REDIS_URL = opts.redisUrl
  process.env.MASTER_ENCRYPTION_KEY = masterKey.toString('base64')
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent'

  const db = createDbClient(opts.databaseUrl)
  const redis = createRedisClient(opts.redisUrl)
  const app = await buildApp({ db, redis, masterKey, logger: { level: 'silent' } })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const addr = app.server.address()
  if (!addr || typeof addr === 'string') throw new Error('listen failed')
  const baseUrl = `http://127.0.0.1:${addr.port}`
  const worker = await startWorker({ db, redis, masterKey, logger: pino({ level: 'silent' }) })

  return {
    app,
    worker,
    db,
    redis,
    masterKey,
    baseUrl,
    close: async () => {
      // Order matters: close the worker first so it stops pulling jobs while
      // the queue/connection is still alive. Then close Fastify, which triggers
      // the queue plugin's onClose hook that closes the queue and quits the
      // shared IORedis connection. Calling `redis.quit()` here would race with
      // that hook and surface as "Connection is closed".
      await worker.close()
      await app.close()
    }
  }
}
