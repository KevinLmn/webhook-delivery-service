import { describe, it, expect } from 'vitest'
import { sha256Hex, idempotencyDecide } from '../src/idempotency'

describe('sha256Hex', () => {
  it('stable for the same input', () => {
    const input = JSON.stringify({ a: 1, b: 2 })
    expect(sha256Hex(input)).toBe(sha256Hex(input))
  })

  it('different hash for different inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'))
  })
})

describe('idempotencyDecide', () => {
  it('absent → fresh, a new event must be created', () => {
    expect(idempotencyDecide({ stored: null, incomingHash: 'h1' })).toEqual({ kind: 'fresh' })
  })

  it('stored with same hash → existing, return event_id', () => {
    expect(
      idempotencyDecide({
        stored: { eventId: 'evt_x', payloadSha256: 'h1' },
        incomingHash: 'h1'
      })
    ).toEqual({ kind: 'existing', eventId: 'evt_x' })
  })

  it('stored with different hash → conflict', () => {
    expect(
      idempotencyDecide({
        stored: { eventId: 'evt_x', payloadSha256: 'h1' },
        incomingHash: 'h2'
      })
    ).toEqual({ kind: 'conflict' })
  })
})
