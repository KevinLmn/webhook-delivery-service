import { eq, sql } from 'drizzle-orm'
import { deliveryAttempts, endpoints, events, type DbClient } from '@vitrine/db'
import { recordOutcome, type DeliveryJobData } from '@vitrine/queue'
import { decryptSecret, newId, parseRetryAfter, type Outcome } from '@vitrine/core'
import type { Job } from 'bullmq'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { deliverOnce } from './http-client'

const TIMEOUT_MS = 10_000
const MAX_RETRY_AFTER_MS = 6 * 3600 * 1000

export interface DeliverContext {
  db: DbClient
  redis: Redis
  masterKey: Buffer
  logger: Logger
}

export type DeliverResult =
  | { kind: 'success' }
  | { kind: 'retry'; reason: Outcome['kind']; delayOverrideMs?: number }
  | { kind: 'dlq'; reason: Outcome['kind'] }
  | { kind: 'breaker_skip'; remainingMs: number }

export async function deliver(
  ctx: DeliverContext,
  job: Job<DeliveryJobData>
): Promise<DeliverResult> {
  const eventId = job.data.eventId
  const [evRow] = await ctx.db
    .select({ event: events, endpoint: endpoints })
    .from(events)
    .innerJoin(endpoints, eq(endpoints.id, events.endpointId))
    .where(eq(events.id, eventId))
    .limit(1)
  if (!evRow) {
    ctx.logger.warn({ eventId }, 'event not found for delivery')
    return { kind: 'dlq', reason: 'http_4xx' } // synthetic; treated as terminal
  }

  const breaker = await recordOutcome(ctx.redis, evRow.endpoint.id, 'read', Date.now())
  if (breaker.state === 'open') {
    const remaining = (breaker.openedAt ?? 0) + breaker.openDurationMs - Date.now()
    await ctx.redis.incr(`breaker:skip_count:${evRow.endpoint.id}`)
    await ctx.redis.expire(`breaker:skip_count:${evRow.endpoint.id}`, 3600)
    return { kind: 'breaker_skip', remainingMs: Math.max(remaining, 1000) }
  }

  if (breaker.state === 'half_open') {
    const lockKey = `breaker:${evRow.endpoint.id}:probe_lock`
    const acquired = await ctx.redis.set(lockKey, '1', 'EX', 5, 'NX')
    if (!acquired) {
      return { kind: 'breaker_skip', remainingMs: 1000 }
    }
  }

  const secret = decryptSecret(evRow.endpoint.secretEncrypted, ctx.masterKey)
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify(evRow.event.payload)

  const result = await deliverOnce({
    url: evRow.endpoint.url,
    body,
    secret,
    eventId,
    timestamp,
    timeoutMs: TIMEOUT_MS
  })

  // Determine attempt number = max(existing) + 1
  const [maxRow] = await ctx.db
    .select({ max: sql<number>`COALESCE(MAX(${deliveryAttempts.attemptNumber}), 0)` })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.eventId, eventId))
  const attemptNumber = (maxRow?.max ?? 0) + 1

  await ctx.db.insert(deliveryAttempts).values({
    id: newId('da'),
    eventId,
    attemptNumber,
    statusCode: result.statusCode,
    durationMs: result.durationMs,
    errorClass: result.outcome.kind === 'success' ? null : result.outcome.kind,
    responseBodyExcerpt: result.responseBodyExcerpt
  })

  // Record breaker outcome
  if (result.outcome.kind === 'success') {
    await recordOutcome(ctx.redis, evRow.endpoint.id, 'success', Date.now())
    await ctx.db
      .update(events)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(eq(events.id, eventId))
    return { kind: 'success' }
  }

  if (result.outcome.kind === 'http_4xx') {
    // 4xx counts as success for breaker (the endpoint is alive, just rejecting this event)
    await recordOutcome(ctx.redis, evRow.endpoint.id, 'success', Date.now())
    await ctx.db
      .update(events)
      .set({ status: 'dead', deadAt: new Date() })
      .where(eq(events.id, eventId))
    return { kind: 'dlq', reason: 'http_4xx' }
  }

  await recordOutcome(ctx.redis, evRow.endpoint.id, 'failure', Date.now())

  if (result.outcome.kind === 'throttle') {
    const overrideMs =
      parseRetryAfter(result.outcome.retryAfterRaw, Date.now(), MAX_RETRY_AFTER_MS) ?? undefined
    return overrideMs !== undefined
      ? { kind: 'retry', reason: 'throttle', delayOverrideMs: overrideMs }
      : { kind: 'retry', reason: 'throttle' }
  }

  return { kind: 'retry', reason: result.outcome.kind }
}
