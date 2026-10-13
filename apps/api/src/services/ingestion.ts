// ============================================================================
//  ingestion.ts — THE ingestion logic (the API's short hot path).
//  Steps: check the endpoint → idempotency (SET NX) → insert → enqueue.
// ============================================================================
import { type StoredIdempotency, idempotencyDecide, newId, sha256Hex } from '@vitrine/core'
import { type DbClient, events } from '@vitrine/db'
import type { DeliveryJobData } from '@vitrine/queue'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import { findEndpointForClient } from './endpoints'

const IDEM_TTL_SEC = 86_400 // the idempotency key lives 24h

export type IngestionResult =
  | { kind: 'created'; eventId: string }   // new event
  | { kind: 'existing'; eventId: string }  // identical replay → same event
  | { kind: 'conflict' }                   // same key, different payload
  | { kind: 'endpoint_not_found' }

export async function ingestEvent(opts: {
  db: DbClient
  redis: Redis
  queue: Queue<DeliveryJobData>
  clientId: string
  endpointId: string
  eventType: string
  payload: unknown
  idempotencyKey: string
}): Promise<IngestionResult> {
  // 1) Does the endpoint exist AND belong to this client? (multi-tenant isolation)
  const ep = await findEndpointForClient(opts.db, opts.clientId, opts.endpointId)
  if (!ep) return { kind: 'endpoint_not_found' }

  // 2) Prepare the idempotency entry: payload hash + a new eventId.
  const payloadStr = JSON.stringify(opts.payload)
  const incomingHash = sha256Hex(payloadStr)
  const eventId = newId('evt')
  const idemKey = `idem:${opts.clientId}:${opts.idempotencyKey}` // key scoped per client
  const idemValue = JSON.stringify({ eventId, payloadSha256: incomingHash })

  // 3) ⭐ SET ... NX = "write ONLY if the key does not exist" → ATOMIC.
  //    This is the building block that keeps ingestion safe even under concurrent requests.
  const setOk = await opts.redis.set(idemKey, idemValue, 'EX', IDEM_TTL_SEC, 'NX')
  if (setOk === null) {
    // The key already existed → this is a replay. Decide: existing or conflict.
    const raw = await opts.redis.get(idemKey)
    if (!raw) return { kind: 'conflict' } // very rare race: the key vanished → play it safe
    const stored = JSON.parse(raw) as StoredIdempotency
    const decision = idempotencyDecide({ stored, incomingHash })
    if (decision.kind === 'existing') return { kind: 'existing', eventId: decision.eventId }
    return { kind: 'conflict' } // same key, but different payload
  }

  // 4) Fresh key → insert the event into the DB (status "pending").
  await opts.db.insert(events).values({
    id: eventId,
    endpointId: opts.endpointId,
    eventType: opts.eventType,
    payload: opts.payload as object,
    status: 'pending'
  })

  // 5) Enqueue the job. jobId: eventId = BullMQ deduplication (one event =
  //    one job, even if add() were accidentally called twice).
  await opts.queue.add('deliver', { eventId }, { jobId: eventId })

  return { kind: 'created', eventId }
}
