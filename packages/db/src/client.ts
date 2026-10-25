import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type DbClient = ReturnType<typeof createDbClient>

export function createDbClient(connectionString: string) {
  // One pool PER PROCESS: API, worker and demo each open up to 10 connections,
  // to count against Postgres' max_connections (100 by default).
  // Outside db.transaction(), every query autocommits: one INSERT = one COMMIT
  // = one WAL flush to disk (see docs/next-ingest.md for what that costs).
  const sql = postgres(connectionString, { max: 10 })
  return drizzle(sql, { schema })
}
