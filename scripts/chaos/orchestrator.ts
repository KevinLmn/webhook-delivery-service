import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { request } from 'undici'
import { createDbClient, type DbClient } from '@vitrine/db'
import { seedClient, seedEndpoint } from '@vitrine/test-helpers'
import IORedis, { type Redis } from 'ioredis'

const COMPOSE_FILE = 'docker-compose.demo.yml'
const HOST_API_PORT = 3001
const HOST_PG_PORT = 5433
const HOST_REDIS_PORT = 6380
const DB_NAME = 'vitrine_demo'

export interface ChaosStack {
  apiBaseUrl: string
  databaseUrl: string
  redisUrl: string
  masterKey: Buffer
  db: DbClient
  redis: Redis
  apiKey: string
  clientId: string
  endpointId: string
  endpointSecret: string
  /** stops the compose stack and closes the clients */
  teardown: () => Promise<void>
}

function run(cmd: string, args: string[], env?: Record<string, string>) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`)
}

async function waitForApi(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await request(`${baseUrl}/ready`)
      if (r.statusCode === 200) {
        await r.body.dump()
        return
      }
      await r.body.dump()
    } catch {
      // not ready yet
    }
    await sleep(1000)
  }
  throw new Error(`API not ready at ${baseUrl} after ${timeoutMs}ms`)
}

export async function bootChaosStack(opts: {
  endpointUrl: string
}): Promise<ChaosStack> {
  const masterKey = randomBytes(32)
  const masterKeyB64 = masterKey.toString('base64')

  // 1) build + up the stack (migrate runs as init via depends_on)
  run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v'])
  run(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--build'],
    { MASTER_ENCRYPTION_KEY: masterKeyB64 }
  )

  const apiBaseUrl = `http://127.0.0.1:${HOST_API_PORT}`
  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${HOST_PG_PORT}/${DB_NAME}`
  const redisUrl = `redis://127.0.0.1:${HOST_REDIS_PORT}`

  // 2) wait for /ready
  await waitForApi(apiBaseUrl, 60_000)

  // 3) seed client + endpoint via the test-helpers package helpers
  const db = createDbClient(databaseUrl)
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null })

  const { clientId, apiKey } = await seedClient(db, { name: 'chaos-demo' })
  const { endpointId, secret } = await seedEndpoint(db, {
    clientId,
    url: opts.endpointUrl,
    masterKey
  })

  return {
    apiBaseUrl,
    databaseUrl,
    redisUrl,
    masterKey,
    db,
    redis,
    apiKey,
    clientId,
    endpointId,
    endpointSecret: secret,
    teardown: async () => {
      try {
        await redis.quit()
      } catch {
        // ignore
      }
      // postgres-js: no trivial close on the drizzle interface; tearing down
      // the compose stack is enough to free host-side network resources.
      run('docker', ['compose', '-f', COMPOSE_FILE, 'down', '-v'])
    }
  }
}
