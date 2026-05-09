import { type StoredIdempotency, idempotencyDecide, newId, sha256Hex } from '@vitrine/core'
import { type DbClient, events } from '@vitrine/db'
import type { DeliveryJobData } from '@vitrine/queue'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import { findEndpointForClient } from './endpoints'

const IDEM_TTL_SEC = 86_400

export type IngestionResult =
  | { kind: 'created'; eventId: string }
  | { kind: 'existing'; eventId: string }
  | { kind: 'conflict' }
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
  const ep = await findEndpointForClient(opts.db, opts.clientId, opts.endpointId)
  if (!ep) return { kind: 'endpoint_not_found' }

  const payloadStr = JSON.stringify(opts.payload)
  const incomingHash = sha256Hex(payloadStr)
  const eventId = newId('evt')
  const idemKey = `idem:${opts.clientId}:${opts.idempotencyKey}`
  const idemValue = JSON.stringify({ eventId, payloadSha256: incomingHash })

  const setOk = await opts.redis.set(idemKey, idemValue, 'EX', IDEM_TTL_SEC, 'NX')
  if (setOk === null) {
    const raw = await opts.redis.get(idemKey)
    if (!raw) return { kind: 'conflict' } // race: key disappeared, conservative
    const stored = JSON.parse(raw) as StoredIdempotency
    const decision = idempotencyDecide({ stored, incomingHash })
    if (decision.kind === 'existing') return { kind: 'existing', eventId: decision.eventId }
    return { kind: 'conflict' }
  }

  await opts.db.insert(events).values({
    id: eventId,
    endpointId: opts.endpointId,
    eventType: opts.eventType,
    payload: opts.payload as object,
    status: 'pending'
  })

  await opts.queue.add('deliver', { eventId }, { jobId: eventId })

  return { kind: 'created', eventId }
}
