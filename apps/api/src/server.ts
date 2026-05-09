import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import type { DbClient } from '@vitrine/db'
import type { Redis } from 'ioredis'
import { type AppConfig, configPlugin, loadConfigFromEnv } from './plugins/config'

export interface BuildAppOptions {
  config?: AppConfig
  db?: DbClient
  redis?: Redis
  masterKey?: Buffer
  logger?: FastifyServerOptions['logger']
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const baseConfig = opts.config ?? loadConfigFromEnv()
  const config: AppConfig = opts.masterKey ? { ...baseConfig, masterKey: opts.masterKey } : baseConfig

  const app = Fastify({ logger: opts.logger ?? { level: config.logLevel } })
  await app.register(configPlugin, { config })

  app.get('/health', async () => ({ ok: true }))
  app.get('/ready', async () => ({ ok: true })) // expanded in task F.6

  return app
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildApp()
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) })
}
