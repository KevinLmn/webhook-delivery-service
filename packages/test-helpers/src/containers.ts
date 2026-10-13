import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface StartedInfra {
  pgContainer: StartedPostgreSqlContainer
  redisContainer: StartedTestContainer
  databaseUrl: string
  redisUrl: string
  stop: () => Promise<void>
}

export async function startInfra(): Promise<StartedInfra> {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ])

  const databaseUrl = pg.getConnectionUri()
  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`

  // Sync the schema against the fresh container.
  // We use `drizzle-kit push --force` rather than `migrate` because the project
  // tracks schema via push (no `__drizzle_migrations` journal table). `--force`
  // skips the interactive TUI confirmation prompt.
  const drizzleDir = path.resolve(__dirname, '../../db')
  execSync('pnpm drizzle-kit push --force', {
    cwd: drizzleDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  })

  return {
    pgContainer: pg,
    redisContainer: redis,
    databaseUrl,
    redisUrl,
    stop: async () => {
      await Promise.all([pg.stop(), redis.stop()])
    },
  }
}
