import { setRetryScheduleOverride } from '@vitrine/core'
import { startInfra, type StartedInfra } from '@vitrine/test-helpers'

let infra: StartedInfra | null = null

export async function setup() {
  // Compress the retry schedule so integration tests don't wait 7 hours between
  // attempts. The schedule still has MAX_ATTEMPTS (=7) entries so BullMQ's
  // `attempts` count stays consistent with the constant captured at module
  // load in `delivery-queue.ts`.
  setRetryScheduleOverride([0, 50, 100, 200, 400, 800, 1600])

  infra = await startInfra()
  process.env.DATABASE_URL = infra.databaseUrl
  process.env.REDIS_URL = infra.redisUrl
}

export async function teardown() {
  await infra?.stop()
  setRetryScheduleOverride(null)
}
