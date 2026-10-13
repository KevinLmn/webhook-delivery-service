// ============================================================================
//  sampler.ts — Reads the system state for one endpoint, once per tick.
//  Postgres = event statuses + the attempt log; Redis = breaker state.
//  Same data sources as scripts/chaos/collector.ts, plus the attempt feed.
// ============================================================================
import { events, type DbClient, deliveryAttempts } from '@vitrine/db'
import { and, count, desc, eq, gte } from 'drizzle-orm'
import type { Redis } from 'ioredis'

export type BreakerState = 'closed' | 'open' | 'half_open'

export interface Sample {
  /** ms since run start */
  t: number
  delivered: number
  pending: number
  dead: number
  breaker: BreakerState
  /** consecutive failures while closed (opens at 5) */
  failCount: number
  /** when the open breaker lets a probe through, ms since run start (null unless open) */
  probeAt: number | null
  /** deliveries postponed because the breaker was open */
  skips: number
  attempts: number
}

export interface Attempt {
  id: string
  eventId: string
  attempt: number
  /** ms since run start */
  t: number
  statusCode: number | null
  durationMs: number
  errorClass: string | null
}

// Shape written by packages/queue/src/lua/record_outcome.lua
interface BreakerJson {
  state: BreakerState
  openedAt: number | null
  failCount: number
  openDurationMs: number
}

/** The breaker is stored as JSON by the Lua script; open → half_open happens lazily on read */
export function readBreaker(
  raw: string | null,
  now: number,
): { state: BreakerState; failCount: number; probeAtEpoch: number | null } {
  if (!raw) return { state: 'closed', failCount: 0, probeAtEpoch: null }
  try {
    const b = JSON.parse(raw) as BreakerJson
    if (b.state === 'open' && typeof b.openedAt === 'number') {
      const probeAt = b.openedAt + b.openDurationMs
      if (probeAt <= now) return { state: 'half_open', failCount: b.failCount, probeAtEpoch: null }
      return { state: 'open', failCount: b.failCount, probeAtEpoch: probeAt }
    }
    return { state: b.state, failCount: b.failCount, probeAtEpoch: null }
  } catch {
    return { state: 'closed', failCount: 0, probeAtEpoch: null }
  }
}

export async function sampleEndpoint(opts: {
  db: DbClient
  redis: Redis
  endpointId: string
  runStartedAt: number
  now: number
}): Promise<Sample> {
  const { db, redis, endpointId, runStartedAt, now } = opts

  const [statusRows, breakerRaw, skipsRaw, attemptRows] = await Promise.all([
    db
      .select({ status: events.status, n: count() })
      .from(events)
      .where(eq(events.endpointId, endpointId))
      .groupBy(events.status),
    redis.get(`breaker:${endpointId}`),
    redis.get(`breaker:skip_count:${endpointId}`),
    db
      .select({ n: count() })
      .from(deliveryAttempts)
      .innerJoin(events, eq(events.id, deliveryAttempts.eventId))
      .where(eq(events.endpointId, endpointId)),
  ])

  const byStatus: Record<string, number> = {}
  for (const r of statusRows) byStatus[r.status] = Number(r.n)
  const breaker = readBreaker(breakerRaw, now)

  return {
    t: now - runStartedAt,
    delivered: byStatus.delivered ?? 0,
    pending: byStatus.pending ?? 0,
    dead: byStatus.dead ?? 0,
    breaker: breaker.state,
    failCount: breaker.failCount,
    probeAt: breaker.probeAtEpoch === null ? null : breaker.probeAtEpoch - runStartedAt,
    skips: skipsRaw ? Number(skipsRaw) : 0,
    attempts: Number(attemptRows[0]?.n ?? 0),
  }
}

/** Attempts recorded since `since` (epoch ms). Callers dedupe by id: the window overlaps on purpose. */
export async function recentAttempts(opts: {
  db: DbClient
  endpointId: string
  runStartedAt: number
  since: number
}): Promise<Attempt[]> {
  const rows = await opts.db
    .select({
      id: deliveryAttempts.id,
      eventId: deliveryAttempts.eventId,
      attempt: deliveryAttempts.attemptNumber,
      attemptedAt: deliveryAttempts.attemptedAt,
      statusCode: deliveryAttempts.statusCode,
      durationMs: deliveryAttempts.durationMs,
      errorClass: deliveryAttempts.errorClass,
    })
    .from(deliveryAttempts)
    .innerJoin(events, eq(events.id, deliveryAttempts.eventId))
    .where(
      and(
        eq(events.endpointId, opts.endpointId),
        gte(deliveryAttempts.attemptedAt, new Date(opts.since)),
      ),
    )
    .orderBy(desc(deliveryAttempts.attemptedAt))
    .limit(200)

  return rows.reverse().map((r) => ({
    id: r.id,
    eventId: r.eventId,
    attempt: r.attempt,
    t: r.attemptedAt.getTime() - opts.runStartedAt,
    statusCode: r.statusCode,
    durationMs: r.durationMs,
    errorClass: r.errorClass,
  }))
}
