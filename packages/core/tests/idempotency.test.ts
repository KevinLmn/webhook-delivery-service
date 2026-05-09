import { describe, it, expect } from 'vitest'
import { sha256Hex, idempotencyDecide } from '../src/idempotency'

describe('sha256Hex', () => {
  it('stable pour le même input', () => {
    const input = JSON.stringify({ a: 1, b: 2 })
    expect(sha256Hex(input)).toBe(sha256Hex(input))
  })

  it('hash différent pour des inputs différents', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'))
  })
})

describe('idempotencyDecide', () => {
  it('absent → fresh, on doit créer un nouvel event', () => {
    expect(idempotencyDecide({ stored: null, incomingHash: 'h1' })).toEqual({ kind: 'fresh' })
  })

  it('stored avec même hash → existing, return event_id', () => {
    expect(
      idempotencyDecide({
        stored: { eventId: 'evt_x', payloadSha256: 'h1' },
        incomingHash: 'h1'
      })
    ).toEqual({ kind: 'existing', eventId: 'evt_x' })
  })

  it('stored avec hash différent → conflict', () => {
    expect(
      idempotencyDecide({
        stored: { eventId: 'evt_x', payloadSha256: 'h1' },
        incomingHash: 'h2'
      })
    ).toEqual({ kind: 'conflict' })
  })
})
