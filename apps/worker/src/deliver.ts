import { type Outcome, decryptSecret, newId, parseRetryAfter } from '@vitrine/core'
import { events, type DbClient, deliveryAttempts, endpoints } from '@vitrine/db'
import { type DeliveryJobData, recordOutcome } from '@vitrine/queue'
import type { Job } from 'bullmq'
// ============================================================================
//  deliver.ts — ORCHESTRATION of ONE delivery attempt.
//  Chains: read breaker → (deliver) → record the attempt → update breaker
//  → update event. Returns a DECISION (success/retry/dlq/breaker_skip) to the worker.
// ============================================================================
import { eq, sql } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { deliverOnce } from './http-client'

const TIMEOUT_MS = 10_000
const MAX_RETRY_AFTER_MS = 6 * 3600 * 1000 // cap any Retry-After at 6h

export interface DeliverContext {
  db: DbClient
  redis: Redis
  masterKey: Buffer
  logger: Logger
}

// The possible decisions returned to the worker:
export type DeliverResult =
  | { kind: 'success' } // delivered → return
  | { kind: 'retry'; reason: Outcome['kind']; delayOverrideMs?: number } // try again
  | { kind: 'dlq'; reason: Outcome['kind'] } // terminal → event "dead"
  | { kind: 'breaker_skip'; remainingMs: number } // endpoint cut off → postpone

export async function deliver(
  ctx: DeliverContext,
  job: Job<DeliveryJobData>,
): Promise<DeliverResult> {
  const eventId = job.data.eventId

  // 1) Load the event + its endpoint (join).
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

  // 2) READ the breaker (event 'read').
  const breaker = await recordOutcome(ctx.redis, evRow.endpoint.id, 'read', Date.now())

  // 2a) OPEN → don't deliver, postpone (the worker will call moveToDelayed).
  if (breaker.state === 'open') {
    const remaining = (breaker.openedAt ?? 0) + breaker.openDurationMs - Date.now()
    // skip counter (observability, 1h TTL)
    await ctx.redis.incr(`breaker:skip_count:${evRow.endpoint.id}`)
    await ctx.redis.expire(`breaker:skip_count:${evRow.endpoint.id}`, 3600)
    return { kind: 'breaker_skip', remainingMs: Math.max(remaining, 1000) }
  }

  // 2b) HALF_OPEN → ⭐ PROBE LOCK: ONE worker probes, the others postpone.
  //     (Avoids a thundering herd on reopening.)
  if (breaker.state === 'half_open') {
    const lockKey = `breaker:${evRow.endpoint.id}:probe_lock`
    const acquired = await ctx.redis.set(lockKey, '1', 'EX', 5, 'NX') // SET NX = atomic lock
    if (!acquired) {
      return { kind: 'breaker_skip', remainingMs: 1000 } // another one is already probing → come back later
    }
  }

  // 3) Decrypt the secret, sign, POST (one attempt).
  const secret = decryptSecret(evRow.endpoint.secretEncrypted, ctx.masterKey)
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify(evRow.event.payload)

  const result = await deliverOnce({
    url: evRow.endpoint.url,
    body,
    secret,
    eventId,
    timestamp,
    timeoutMs: TIMEOUT_MS,
  })

  // 4) Record this attempt. attemptNumber = max(existing) + 1.
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
    responseBodyExcerpt: result.responseBodyExcerpt,
  })

  // 5) Depending on the result: update breaker + update event + decision.

  // 5a) SUCCESS (2xx/3xx) → breaker success, event "delivered".
  if (result.outcome.kind === 'success') {
    await recordOutcome(ctx.redis, evRow.endpoint.id, 'success', Date.now())
    await ctx.db
      .update(events)
      .set({ status: 'delivered', deliveredAt: new Date() })
      .where(eq(events.id, eventId))
    return { kind: 'success' }
  }

  // 5b) 4xx → ⭐ breaker "success" (the endpoint is ALIVE, it just rejects this
  //     content), but event "dead" (retrying wouldn't change anything).
  if (result.outcome.kind === 'http_4xx') {
    await recordOutcome(ctx.redis, evRow.endpoint.id, 'success', Date.now())
    await ctx.db
      .update(events)
      .set({ status: 'dead', deadAt: new Date() })
      .where(eq(events.id, eventId))
    return { kind: 'dlq', reason: 'http_4xx' }
  }

  // 5c) Everything else (5xx, timeout, network, throttle) → breaker "failure" + retry.
  await recordOutcome(ctx.redis, evRow.endpoint.id, 'failure', Date.now())

  // 429: honor Retry-After if present and valid.
  if (result.outcome.kind === 'throttle') {
    const overrideMs =
      parseRetryAfter(result.outcome.retryAfterRaw, Date.now(), MAX_RETRY_AFTER_MS) ?? undefined
    return overrideMs !== undefined
      ? { kind: 'retry', reason: 'throttle', delayOverrideMs: overrideMs }
      : { kind: 'retry', reason: 'throttle' }
  }

  // 5xx / timeout / network → normal retry (BullMQ will apply the backoff).
  return { kind: 'retry', reason: result.outcome.kind }
}
