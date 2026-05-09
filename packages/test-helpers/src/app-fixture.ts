// @ts-nocheck
// TODO: remove after G.3 implements startWorker matching signature
// (F.1 already provides matching buildApp signature)
import { buildApp } from '../../../apps/api/src/server'
import { startWorker } from '../../../apps/worker/src/worker'
import { createDbClient } from '@vitrine/db'
import { createRedisClient } from '@vitrine/queue'
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
  const env = {
    DATABASE_URL: opts.databaseUrl,
    REDIS_URL: opts.redisUrl,
    MASTER_ENCRYPTION_KEY: masterKey.toString('base64'),
    LOG_LEVEL: 'silent'
  }
  const db = createDbClient(opts.databaseUrl)
  const redis = createRedisClient(opts.redisUrl)
  const app = await buildApp({ db, redis, masterKey, logger: { level: 'silent' } })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const addr = app.server.address()
  if (!addr || typeof addr === 'string') throw new Error('listen failed')
  const baseUrl = `http://127.0.0.1:${addr.port}`
  const worker = await startWorker({ db, redis, masterKey, logger: { level: 'silent' } })

  return {
    app,
    worker,
    db,
    redis,
    masterKey,
    baseUrl,
    close: async () => {
      await worker.close()
      await app.close()
      await redis.quit()
    }
  }
}
