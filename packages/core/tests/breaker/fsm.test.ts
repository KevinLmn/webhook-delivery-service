import { describe, expect, it } from 'vitest'
import { type BreakerState, transition } from '../../src/breaker/fsm'

const NOW = 1_700_000_000_000
const INITIAL_OPEN_MS = 30_000
const MAX_OPEN_MS = 1_800_000

const closed = (failCount: number): BreakerState => ({
  state: 'closed',
  openedAt: null,
  failCount,
  openDurationMs: INITIAL_OPEN_MS,
})

const open = (openDurationMs: number, openedAt = NOW): BreakerState => ({
  state: 'open',
  openedAt,
  failCount: 0,
  openDurationMs,
})

const halfOpen = (openDurationMs: number): BreakerState => ({
  state: 'half_open',
  openedAt: null,
  failCount: 0,
  openDurationMs,
})

describe('breaker FSM transition', () => {
  it('closed + success → closed (failCount reset)', () => {
    expect(transition(closed(3), 'success', NOW)).toEqual(closed(0))
  })

  it('closed + failure (failCount<4) → closed (failCount++)', () => {
    expect(transition(closed(2), 'failure', NOW)).toEqual(closed(3))
  })

  it('closed + 5th consecutive failure → open (30s)', () => {
    expect(transition(closed(4), 'failure', NOW)).toEqual(open(INITIAL_OPEN_MS, NOW))
  })

  it('open before TTL + read → stays open (lazy)', () => {
    const s = open(INITIAL_OPEN_MS, NOW - 10_000)
    expect(transition(s, 'read', NOW)).toEqual(s)
  })

  it('open after TTL + read → half_open (lazy)', () => {
    const s = open(INITIAL_OPEN_MS, NOW - INITIAL_OPEN_MS - 1)
    expect(transition(s, 'read', NOW)).toEqual(halfOpen(INITIAL_OPEN_MS))
  })

  it('half_open + success (probe) → closed (reset open_duration)', () => {
    expect(transition(halfOpen(120_000), 'success', NOW)).toEqual(closed(0))
  })

  it('half_open + failure (probe) → open (duration doubled)', () => {
    expect(transition(halfOpen(60_000), 'failure', NOW)).toEqual(open(120_000, NOW))
  })

  it('half_open + failure capped at 30 min', () => {
    expect(transition(halfOpen(20 * 60_000), 'failure', NOW)).toEqual(open(MAX_OPEN_MS, NOW))
  })

  it('open + success (normally impossible, defensive) → closed', () => {
    // Defensive case: if a success ever arrives while open before TTL, close.
    // This shouldn't happen since the worker calls moveToDelayed first.
    expect(transition(open(INITIAL_OPEN_MS, NOW - 1000), 'success', NOW).state).toBe('closed')
  })

  it('open + failure (before TTL) → stays open with counter reset', () => {
    // Defensive case: a failure that still arrives while open (race). Keep the state.
    const s = open(INITIAL_OPEN_MS, NOW - 1000)
    expect(transition(s, 'failure', NOW)).toEqual(s)
  })
})
