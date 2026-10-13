import { type DbClient, deliveryAttempts, events } from '@vitrine/db'
import { and, count, eq, gte } from 'drizzle-orm'
import type { Redis } from 'ioredis'

export interface Sample {
  /** ms since the run's global startedAt */
  tMs: number
  delivered: number
  pending: number
  dead: number
  breakerState: 'closed' | 'open' | 'half_open' | 'unknown'
  breakerSkipCount: number
  /** P50 and P99 of duration_ms over attempts completed in the last window */
  p50LatencyMs: number | null
  p99LatencyMs: number | null
  totalAttempts: number
}

interface BreakerJson {
  state: 'closed' | 'open' | 'half_open'
  opened_at: number | null
  fail_count: number
  open_duration_ms: number
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length))
  return sortedAsc[idx] ?? null
}

export async function sampleOnce(opts: {
  db: DbClient
  redis: Redis
  endpointId: string
  runStartedAt: number
  windowMs: number
}): Promise<Sample> {
  const { db, redis, endpointId, runStartedAt, windowMs } = opts
  const now = Date.now()

  const [statusRows, breakerJson, skipCount, recentLatencies] = await Promise.all([
    db
      .select({ status: events.status, n: count() })
      .from(events)
      .where(eq(events.endpointId, endpointId))
      .groupBy(events.status),
    redis.get(`breaker:${endpointId}`),
    redis.get(`breaker:skip_count:${endpointId}`).then((v) => (v ? Number(v) : 0)),
    db
      .select({ d: deliveryAttempts.durationMs })
      .from(deliveryAttempts)
      .innerJoin(events, eq(events.id, deliveryAttempts.eventId))
      .where(
        and(
          eq(events.endpointId, endpointId),
          gte(deliveryAttempts.attemptedAt, new Date(now - windowMs))
        )
      )
      .limit(500)
  ])

  let delivered = 0
  let pending = 0
  let dead = 0
  for (const r of statusRows) {
    if (r.status === 'delivered') delivered = Number(r.n)
    else if (r.status === 'pending') pending = Number(r.n)
    else if (r.status === 'dead') dead = Number(r.n)
  }

  let breakerState: Sample['breakerState'] = 'closed'
  if (breakerJson) {
    try {
      const parsed = JSON.parse(breakerJson) as BreakerJson
      breakerState = parsed.state
      // Lazy open → half_open transition: if expiry has passed at read time,
      // show it as half_open in the viz (consistent with the runtime logic).
      if (
        parsed.state === 'open' &&
        parsed.opened_at !== null &&
        parsed.opened_at + parsed.open_duration_ms <= now
      ) {
        breakerState = 'half_open'
      }
    } catch {
      breakerState = 'unknown'
    }
  } else {
    breakerState = 'closed'
  }

  const sortedLatencies = recentLatencies.map((r) => r.d).sort((a, b) => a - b)

  return {
    tMs: now - runStartedAt,
    delivered,
    pending,
    dead,
    breakerState,
    breakerSkipCount: skipCount,
    p50LatencyMs: percentile(sortedLatencies, 50),
    p99LatencyMs: percentile(sortedLatencies, 99),
    totalAttempts: sortedLatencies.length
  }
}
