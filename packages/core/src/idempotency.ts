import { createHash } from 'node:crypto'

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export interface StoredIdempotency {
  eventId: string
  payloadSha256: string
}

export type IdempotencyDecision =
  | { kind: 'fresh' }
  | { kind: 'existing'; eventId: string }
  | { kind: 'conflict' }

export function idempotencyDecide(params: {
  stored: StoredIdempotency | null
  incomingHash: string
}): IdempotencyDecision {
  if (params.stored === null) return { kind: 'fresh' }
  if (params.stored.payloadSha256 === params.incomingHash) {
    return { kind: 'existing', eventId: params.stored.eventId }
  }
  return { kind: 'conflict' }
}
