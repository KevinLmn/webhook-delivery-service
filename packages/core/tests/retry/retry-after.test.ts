import { describe, it, expect } from 'vitest'
import { parseRetryAfter } from '../../src/retry/retry-after'

describe('parseRetryAfter', () => {
  const now = new Date('2026-05-09T10:00:00Z').getTime()
  const MAX = 6 * 3600 * 1000

  it('null si header absent', () => {
    expect(parseRetryAfter(null, now, MAX)).toBe(null)
  })

  it('valeur numérique en secondes', () => {
    expect(parseRetryAfter('30', now, MAX)).toBe(30_000)
  })

  it('rejette les valeurs négatives', () => {
    expect(parseRetryAfter('-5', now, MAX)).toBe(null)
  })

  it('rejette les valeurs au-delà du max', () => {
    expect(parseRetryAfter(String(7 * 3600), now, MAX)).toBe(null)
  })

  it('parse une date HTTP au format RFC 7231', () => {
    const future = 'Sat, 09 May 2026 10:00:30 GMT'
    expect(parseRetryAfter(future, now, MAX)).toBe(30_000)
  })

  it('rejette une date dans le passé', () => {
    const past = 'Sat, 09 May 2026 09:59:00 GMT'
    expect(parseRetryAfter(past, now, MAX)).toBe(null)
  })

  it('rejette une string non parseable', () => {
    expect(parseRetryAfter('abc', now, MAX)).toBe(null)
  })
})
