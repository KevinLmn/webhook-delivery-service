import { type DbClient, createDbClient } from '@vitrine/db'
import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyInstance {
    db: DbClient
  }
}

export const dbPlugin = fp<{ db?: DbClient }>(async (app, opts) => {
  const db = opts.db ?? createDbClient(app.config.databaseUrl)
  app.decorate('db', db)
})
