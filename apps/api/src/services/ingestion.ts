// ============================================================================
//  ingestion.ts — THE ingestion logic (the API's short hot path).
//  Steps: check the endpoint → idempotency (SET NX) → insert → enqueue.
// ============================================================================
import { type StoredIdempotency, idempotencyDecide, newId, sha256Hex } from '@vitrine/core'
import { events, type DbClient } from '@vitrine/db'
import type { DeliveryJobData } from '@vitrine/queue'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import { findEndpointForClient } from './endpoints'

const IDEM_TTL_SEC = 86_400 // the idempotency key lives 24h

export type IngestionResult =
  | { kind: 'created'; eventId: string } // new event
  | { kind: 'existing'; eventId: string } // identical replay → same event
  | { kind: 'conflict' } // same key, different payload
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
  // Hash of the RE-serialized payload: it follows the client's key order, so the
  // same object sent with keys reordered counts as a different payload (→ 422).
  const payloadStr = JSON.stringify(opts.payload)
  const incomingHash = sha256Hex(payloadStr)
  // The id is minted BEFORE the claim so the single atomic SET NX stores which
  // event this key maps to: no second round trip, no window without a value.
  const eventId = newId('evt')
  const idemKey = `idem:${opts.clientId}:${opts.idempotencyKey}` // key scoped per client
  const idemValue = JSON.stringify({ eventId, payloadSha256: incomingHash })

  // 3) ⭐ SET ... NX = "write ONLY if the key does not exist" → ATOMIC.
  //    This is the building block that keeps ingestion safe even under concurrent requests.
  //    Known gap: the key is claimed BEFORE the Postgres insert. If the insert
  //    or the enqueue below fails, the key still points to this eventId for 24h,
  //    and a client retry gets 200 for an event that was never stored.
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
  //    No transaction around insert + enqueue: it would span two systems
  //    (Postgres and Redis), which a DB transaction can't do. A crash between
  //    the two leaves a "pending" row with no job; a transactional outbox (or a
  //    sweeper re-enqueuing old pending rows) would close that gap.
  await opts.db.insert(events).values({
    id: eventId,
    endpointId: opts.endpointId,
    eventType: opts.eventType,
    payload: opts.payload as object,
    status: 'pending',
  })

  // 5) Enqueue the job. jobId: eventId = BullMQ deduplication (one event =
  //    one job, even if add() were accidentally called twice).
  await opts.queue.add('deliver', { eventId }, { jobId: eventId })

  return { kind: 'created', eventId }
}
