export type BreakerStateName = 'closed' | 'open' | 'half_open'

export interface BreakerState {
  state: BreakerStateName
  openedAt: number | null
  failCount: number
  openDurationMs: number
}

export type BreakerEvent = 'success' | 'failure' | 'read'

export const FAIL_THRESHOLD = 5
export const INITIAL_OPEN_MS = 30_000
export const MAX_OPEN_MS = 30 * 60_000

export function defaultState(): BreakerState {
  return { state: 'closed', openedAt: null, failCount: 0, openDurationMs: INITIAL_OPEN_MS }
}

export function transition(state: BreakerState, event: BreakerEvent, nowMs: number): BreakerState {
  if (state.state === 'closed') {
    if (event === 'success') return { ...state, failCount: 0 }
    if (event === 'failure') {
      const next = state.failCount + 1
      if (next >= FAIL_THRESHOLD) {
        return {
          state: 'open',
          openedAt: nowMs,
          failCount: 0,
          openDurationMs: INITIAL_OPEN_MS
        }
      }
      return { ...state, failCount: next }
    }
    return state // read in closed = noop
  }

  if (state.state === 'open') {
    if (event === 'read') {
      const expiresAt = (state.openedAt ?? 0) + state.openDurationMs
      if (nowMs > expiresAt) {
        return {
          state: 'half_open',
          openedAt: null,
          failCount: 0,
          openDurationMs: state.openDurationMs
        }
      }
      return state
    }
    if (event === 'success') {
      // Defensive: success in open shouldn't occur (workers should moveToDelayed).
      // If it does, close cleanly.
      return { state: 'closed', openedAt: null, failCount: 0, openDurationMs: INITIAL_OPEN_MS }
    }
    // failure in open: keep open (defensive, race-condition guard)
    return state
  }

  // half_open
  if (event === 'success') {
    return { state: 'closed', openedAt: null, failCount: 0, openDurationMs: INITIAL_OPEN_MS }
  }
  if (event === 'failure') {
    const doubled = Math.min(state.openDurationMs * 2, MAX_OPEN_MS)
    return { state: 'open', openedAt: nowMs, failCount: 0, openDurationMs: doubled }
  }
  return state
}
