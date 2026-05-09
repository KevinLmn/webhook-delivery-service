import { afterEach, describe, it, expect } from 'vitest'
import {
  backoffMs,
  RETRY_SCHEDULE_MS,
  setRetryScheduleOverride,
  getActiveSchedule
} from '../../src/retry/backoff'

afterEach(() => setRetryScheduleOverride(null))

describe('backoffMs', () => {
  it('retourne 0 pour la première tentative', () => {
    expect(backoffMs(1, () => 0.5)).toBe(0)
  })

  it('respecte le schedule pour les attempts 2-7', () => {
    const noJitter = () => 0.5 // (0.8 + 0.5*0.4) = 1.0 → pas de jitter
    expect(backoffMs(2, noJitter)).toBe(1_000)
    expect(backoffMs(3, noJitter)).toBe(10_000)
    expect(backoffMs(4, noJitter)).toBe(60_000)
    expect(backoffMs(5, noJitter)).toBe(600_000)
    expect(backoffMs(6, noJitter)).toBe(3_600_000)
    expect(backoffMs(7, noJitter)).toBe(21_600_000)
  })

  it('applique un jitter de ±20% multiplicatif', () => {
    const minJitter = () => 0 // 0.8x
    const maxJitter = () => 1 // 1.2x
    expect(backoffMs(2, minJitter)).toBe(800)
    expect(backoffMs(2, maxJitter)).toBe(1_200)
  })

  it('throws pour attempt >= 8 (au-delà du schedule)', () => {
    expect(() => backoffMs(8)).toThrow(/out of schedule/)
  })

  it('throws pour attempt <= 0', () => {
    expect(() => backoffMs(0)).toThrow()
  })

  it('expose la table RETRY_SCHEDULE_MS', () => {
    expect(RETRY_SCHEDULE_MS).toEqual([0, 1_000, 10_000, 60_000, 600_000, 3_600_000, 21_600_000])
  })

  it('schedule override remplace la table', () => {
    setRetryScheduleOverride([0, 50, 100])
    expect(getActiveSchedule()).toEqual([0, 50, 100])
    expect(backoffMs(2, () => 0.5)).toBe(50)
  })
})
