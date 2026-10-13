import { describe, expect, it } from 'vitest'
import { CooldownLimiter } from '../src/rate-limit'

describe('CooldownLimiter', () => {
  it('allows the first hit and blocks until the cooldown is over', () => {
    const limiter = new CooldownLimiter(1_000)
    expect(limiter.tryAcquire('1.2.3.4', 0)).toBe(0)
    expect(limiter.tryAcquire('1.2.3.4', 400)).toBe(600)
    expect(limiter.tryAcquire('1.2.3.4', 1_000)).toBe(0)
  })

  it('keys are independent', () => {
    const limiter = new CooldownLimiter(1_000)
    expect(limiter.tryAcquire('a', 0)).toBe(0)
    expect(limiter.tryAcquire('b', 1)).toBe(0)
  })
})
