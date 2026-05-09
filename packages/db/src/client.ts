import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type DbClient = ReturnType<typeof createDbClient>

export function createDbClient(connectionString: string) {
  const sql = postgres(connectionString, { max: 10 })
  return drizzle(sql, { schema })
}
