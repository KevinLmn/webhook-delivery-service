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
    expect(respond({ elapsedMs: 20_000, poison: true, flakySeq: 0 })).toBe(500)
  })

  it('poison payloads are rejected with 422 when the endpoint is up', () => {
    expect(respond({ elapsedMs: 1_000, poison: true, flakySeq: 0 })).toBe(422)
    expect(respond({ elapsedMs: 100_000, poison: true, flakySeq: 0 })).toBe(422)
  })

  it('the flaky phase fails one request in three, and its first request (the probe) succeeds', () => {
    const codes = [0, 1, 2, 3, 4, 5].map((flakySeq) =>
      respond({ elapsedMs: 50_000, poison: false, flakySeq }),
    )
    expect(codes).toEqual([200, 200, 500, 200, 200, 500])
  })

  it('1 event in 25 is poison', () => {
    const poison = Array.from({ length: TOTAL_EVENTS }, (_, i) => i).filter(isPoison)
    expect(poison).toHaveLength(TOTAL_EVENTS / 25)
    expect(poison.slice(0, 2)).toEqual([24, 49])
  })

  it('pushes are spread over the push window', () => {
    expect(pushOffsetMs(0)).toBe(0)
    expect(pushOffsetMs(TOTAL_EVENTS - 1)).toBeLessThan(PUSH_DURATION_MS)
    expect(pushOffsetMs(TOTAL_EVENTS / 2)).toBe(PUSH_DURATION_MS / 2)
  })
})
