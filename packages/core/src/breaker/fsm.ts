// ============================================================================
//  fsm.ts — The circuit breaker STATE MACHINE (PURE reference version).
//  (The version that actually runs is Lua in Redis, for atomicity —
//   see packages/queue/src/lua/record_outcome.lua. This pure version is the
//   source of truth for the LOGIC, easy to unit test.)
//
//  Idea: if an endpoint keeps failing, we "trip the breaker" to stop
//  hammering it, then carefully probe whether it has recovered.
// ============================================================================

// The 3 breaker states.
export type BreakerStateName = 'closed' | 'open' | 'half_open'

export interface BreakerState {
  state: BreakerStateName
  openedAt: number | null // when we went "open" (to compute when the cooldown ends)
  failCount: number // number of consecutive failures (counted in "closed")
  openDurationMs: number // current cooldown duration (doubles on each relapse)
}

// The events that can be sent to the breaker.
export type BreakerEvent = 'success' | 'failure' | 'read'

export const FAIL_THRESHOLD = 5 // 5 consecutive failures → open
export const INITIAL_OPEN_MS = 30_000 // initial cooldown: 30s
export const MAX_OPEN_MS = 30 * 60_000 // cooldown cap: 30 min

// Initial state: closed (all good).
export function defaultState(): BreakerState {
  return { state: 'closed', openedAt: null, failCount: 0, openDurationMs: INITIAL_OPEN_MS }
}

// THE transition function: (current state, event, now) → new state.
export function transition(state: BreakerState, event: BreakerEvent, nowMs: number): BreakerState {
  // --- CLOSED state (normal) ---
  if (state.state === 'closed') {
    if (event === 'success') return { ...state, failCount: 0 } // success → reset the counter to 0
    if (event === 'failure') {
      const next = state.failCount + 1
      if (next >= FAIL_THRESHOLD) {
        // 5th failure → OPEN the breaker.
        return {
          state: 'open',
          openedAt: nowMs,
          failCount: 0,
          openDurationMs: INITIAL_OPEN_MS,
        }
      }
      return { ...state, failCount: next } // still below the threshold
    }
    return state // 'read' while closed = nothing to do
  }

  // --- OPEN state (tripped) ---
  if (state.state === 'open') {
    if (event === 'read') {
      // On a read, check whether the cooldown has elapsed.
      const expiresAt = (state.openedAt ?? 0) + state.openDurationMs
      if (nowMs > expiresAt) {
        // Cooldown over → go HALF_OPEN (we'll probe carefully).
        return {
          state: 'half_open',
          openedAt: null,
          failCount: 0,
          openDurationMs: state.openDurationMs,
        }
      }
      return state // still cooling down
    }
    if (event === 'success') {
      // Defensive: a success while "open" shouldn't happen (the worker defers).
      // If it does, close cleanly.
      return { state: 'closed', openedAt: null, failCount: 0, openDurationMs: INITIAL_OPEN_MS }
    }
    // failure while open: stay open (guard against races).
    return state
  }

  // --- HALF_OPEN state (probe) ---
  if (event === 'success') {
    // The endpoint responds again → CLOSE (healed), cooldown reset to initial.
    return { state: 'closed', openedAt: null, failCount: 0, openDurationMs: INITIAL_OPEN_MS }
  }
  if (event === 'failure') {
    // The probe fails → REOPEN and DOUBLE the cooldown (up to 30 min max).
    // = exponential backoff at the endpoint level.
    const doubled = Math.min(state.openDurationMs * 2, MAX_OPEN_MS)
    return { state: 'open', openedAt: nowMs, failCount: 0, openDurationMs: doubled }
  }
  return state // 'read' while half_open = noop
}
