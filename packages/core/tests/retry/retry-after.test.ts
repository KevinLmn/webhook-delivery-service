import { describe, it, expect } from 'vitest'
import { parseRetryAfter } from '../../src/retry/retry-after'

describe('parseRetryAfter', () => {
  const now = new Date('2026-05-09T10:00:00Z').getTime()
  const MAX = 6 * 3600 * 1000

  it('null when header is absent', () => {
    expect(parseRetryAfter(null, now, MAX)).toBe(null)
  })

  it('numeric value in seconds', () => {
    expect(parseRetryAfter('30', now, MAX)).toBe(30_000)
  })

  it('rejects negative values', () => {
    expect(parseRetryAfter('-5', now, MAX)).toBe(null)
  })

  it('rejects values beyond the max', () => {
    expect(parseRetryAfter(String(7 * 3600), now, MAX)).toBe(null)
  })

  it('parses an RFC 7231 HTTP date', () => {
    const future = 'Sat, 09 May 2026 10:00:30 GMT'
    expect(parseRetryAfter(future, now, MAX)).toBe(30_000)
  })

  it('rejects a date in the past', () => {
    const past = 'Sat, 09 May 2026 09:59:00 GMT'
    expect(parseRetryAfter(past, now, MAX)).toBe(null)
  })

  it('rejects an unparseable string', () => {
    expect(parseRetryAfter('abc', now, MAX)).toBe(null)
  })
})
