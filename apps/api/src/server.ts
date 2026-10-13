// ============================================================================
//  server.ts — Assembles the API application (Fastify): plugins + routes.
//  buildApp() is written for DEPENDENCY INJECTION: you can pass db,
//  redis, masterKey (for tests with Testcontainers) or keep the defaults.
// ============================================================================
import type { DbClient } from '@vitrine/db'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { Redis } from 'ioredis'
import { authPlugin } from './plugins/auth'
import { type AppConfig, configPlugin, loadConfigFromEnv } from './plugins/config'
import { dbPlugin } from './plugins/db'
import { queuePlugin } from './plugins/queue'
import { endpointsRoutes } from './routes/endpoints'
import { eventsRoutes } from './routes/events'
import { replayRoutes } from './routes/replay'

// All dependencies are optional → defaults in prod, injected in tests.
export interface BuildAppOptions {
  config?: AppConfig
  db?: DbClient
  redis?: Redis
  masterKey?: Buffer
  logger?: FastifyServerOptions['logger']
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  // Config: the injected one, otherwise loaded from environment variables.
  const baseConfig = opts.config ?? loadConfigFromEnv()
  const config: AppConfig = opts.masterKey
    ? { ...baseConfig, masterKey: opts.masterKey }
    : baseConfig

  const app = Fastify({ logger: opts.logger ?? { level: config.logLevel } })

  // PLUGINS attach dependencies to `app` (app.db, app.redis, app.deliveryQueue…).
  await app.register(configPlugin, { config })
  await app.register(dbPlugin, opts.db ? { db: opts.db } : {})
  await app.register(queuePlugin, opts.redis ? { redis: opts.redis } : {})
  await app.register(authPlugin) // decodes the Bearer token → sets request.clientId

  // Business ROUTES.
  await app.register(endpointsRoutes)
  await app.register(eventsRoutes)
  await app.register(replayRoutes)

  // Health = "the process responds". Ready = "I can serve" (deps OK).
  app.get('/health', async () => ({ ok: true }))
  app.get('/ready', async () => {
    try {
      await app.redis.ping()
      // db readiness check via simple SELECT — added when db package exposes a ping helper
      return { ok: true }
    } catch {
      throw new Error('not ready')
    }
  })

  return app
}

// If this file is run DIRECTLY (not imported), start the server.
// (The `import.meta.url === file://argv[1]` pattern = "am I the entry point?")
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildApp()
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) })
}
