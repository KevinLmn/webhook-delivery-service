import { afterEach, describe, expect, it } from 'vitest'
import {
  RETRY_SCHEDULE_MS,
  backoffMs,
  getActiveSchedule,
  setRetryScheduleOverride,
} from '../../src/retry/backoff'

afterEach(() => setRetryScheduleOverride(null))

describe('backoffMs', () => {
  it('returns 0 for the first attempt', () => {
    expect(backoffMs(1, () => 0.5)).toBe(0)
  })

  it('follows the schedule for attempts 2-7', () => {
    const noJitter = () => 0.5 // (0.8 + 0.5*0.4) = 1.0 → no jitter
    expect(backoffMs(2, noJitter)).toBe(1_000)
    expect(backoffMs(3, noJitter)).toBe(10_000)
    expect(backoffMs(4, noJitter)).toBe(60_000)
    expect(backoffMs(5, noJitter)).toBe(600_000)
    expect(backoffMs(6, noJitter)).toBe(3_600_000)
    expect(backoffMs(7, noJitter)).toBe(21_600_000)
  })

  it('applies a ±20% multiplicative jitter', () => {
    const minJitter = () => 0 // 0.8x
    const maxJitter = () => 1 // 1.2x
    expect(backoffMs(2, minJitter)).toBe(800)
    expect(backoffMs(2, maxJitter)).toBe(1_200)
  })

  it('throws for attempt >= 8 (beyond the schedule)', () => {
    expect(() => backoffMs(8)).toThrow(/out of schedule/)
  })

  it('throws for attempt <= 0', () => {
    expect(() => backoffMs(0)).toThrow()
  })

  it('exposes the RETRY_SCHEDULE_MS table', () => {
    expect(RETRY_SCHEDULE_MS).toEqual([0, 1_000, 10_000, 60_000, 600_000, 3_600_000, 21_600_000])
  })

  it('schedule override replaces the table', () => {
    setRetryScheduleOverride([0, 50, 100])
    expect(getActiveSchedule()).toEqual([0, 50, 100])
    expect(backoffMs(2, () => 0.5)).toBe(50)
  })
})
