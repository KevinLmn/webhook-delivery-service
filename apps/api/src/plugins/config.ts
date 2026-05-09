import fp from 'fastify-plugin'
import { z } from 'zod'

export interface AppConfig {
  databaseUrl: string
  redisUrl: string
  masterKey: Buffer
  logLevel: string
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig
  }
}

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  MASTER_ENCRYPTION_KEY: z.string().min(1),
  LOG_LEVEL: z.string().default('info')
})

export function loadConfigFromEnv(): AppConfig {
  const env = EnvSchema.parse(process.env)
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    masterKey: Buffer.from(env.MASTER_ENCRYPTION_KEY, 'base64'),
    logLevel: env.LOG_LEVEL
  }
}

export const configPlugin = fp<{ config: AppConfig }>(async (app, opts) => {
  app.decorate('config', opts.config)
})
