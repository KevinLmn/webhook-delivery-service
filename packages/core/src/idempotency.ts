// ============================================================================
//  idempotency.ts — The idempotency DECISION (pure logic, no Redis here).
//  Goal: if a client sends the same request twice, do NOT create 2 events.
//  The Redis call (SET NX) lives in services/ingestion.ts; here, just the decision.
// ============================================================================
import { createHash } from 'node:crypto'

// SHA-256 hash (hex) of a string — used to compare payloads.
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

// What we stored in Redis for an idempotency key: the created event + the payload hash.
export interface StoredIdempotency {
  eventId: string
  payloadSha256: string
}

// The 3 possible outcomes:
export type IdempotencyDecision =
  | { kind: 'fresh' } //  never seen → create the event
  | { kind: 'existing'; eventId: string } //  already seen, SAME payload → return the same event
  | { kind: 'conflict' } //  same key, DIFFERENT payload → error (422)

// The decision rule, based on what is stored and the incoming hash.
export function idempotencyDecide(params: {
  stored: StoredIdempotency | null
  incomingHash: string
}): IdempotencyDecision {
  if (params.stored === null) return { kind: 'fresh' } // key not found
  // Same key + same content → a true duplicate, return the existing event.
  if (params.stored.payloadSha256 === params.incomingHash) {
    return { kind: 'existing', eventId: params.stored.eventId }
  }
  // Same key but different content → the client is misusing the key.
  return { kind: 'conflict' }
}
