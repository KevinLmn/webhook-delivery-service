import { describe, expect, it } from 'vitest'
import {
  PHASES,
  PUSH_DURATION_MS,
  RUN_DURATION_MS,
  TOTAL_EVENTS,
  isPoison,
  phaseIndexAt,
  pushOffsetMs,
  respond,
} from '../src/scenario'

describe('scenario', () => {
  it('phases are contiguous and cover the whole run', () => {
    expect(PHASES[0]?.startMs).toBe(0)
    for (let i = 1; i < PHASES.length; i++) {
      expect(PHASES[i]?.startMs).toBe(PHASES[i - 1]?.endMs)
    }
    expect(PHASES.at(-1)?.endMs).toBe(RUN_DURATION_MS)
  })

  it('phaseIndexAt picks the phase whose window contains t', () => {
    expect(phaseIndexAt(0)).toBe(0)
    expect(phaseIndexAt(9_999)).toBe(0)
    expect(phaseIndexAt(10_000)).toBe(1)
    expect(phaseIndexAt(45_000)).toBe(2)
    expect(phaseIndexAt(200_000)).toBe(3)
  })

  it('an outage returns 500 even for poison payloads', () => {
    expect(respond({ elapsedMs: 20_000, poison: true, random: 0.9 })).toBe(500)
  })

  it('poison payloads are rejected with 422 when the endpoint is up', () => {
    expect(respond({ elapsedMs: 1_000, poison: true, random: 0.9 })).toBe(422)
    expect(respond({ elapsedMs: 100_000, poison: true, random: 0.9 })).toBe(422)
  })

  it('the flaky phase fails half the time', () => {
    expect(respond({ elapsedMs: 50_000, poison: false, random: 0.2 })).toBe(500)
    expect(respond({ elapsedMs: 50_000, poison: false, random: 0.7 })).toBe(200)
  })

  it('4 events out of 100 are poison', () => {
    const poison = Array.from({ length: TOTAL_EVENTS }, (_, i) => i).filter(isPoison)
    expect(poison).toEqual([24, 49, 74, 99])
  })

  it('pushes are spread over the push window', () => {
    expect(pushOffsetMs(0)).toBe(0)
    expect(pushOffsetMs(TOTAL_EVENTS - 1)).toBeLessThan(PUSH_DURATION_MS)
    expect(pushOffsetMs(50)).toBe(PUSH_DURATION_MS / 2)
  })
})
