// ============================================================================
//  backoff.ts — The retry SCHEDULE (exponential backoff) + jitter.
//  How long to wait before attempt N?
// ============================================================================

// Delay BEFORE each attempt. attempt 1 = immediate, then increasingly spaced out.
export const RETRY_SCHEDULE_MS = [
  0, // attempt 1: immediate
  1_000, // attempt 2: 1s
  10_000, // attempt 3: 10s
  60_000, // attempt 4: 1min
  600_000, // attempt 5: 10min
  3_600_000, // attempt 6: 1h
  21_600_000, // attempt 7: 6h
] as const

export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length // 7 attempts max
export const JITTER_RATIO = 0.2 // ±20% randomness on the delay

// The "active" schedule can be swapped in TESTS (to run fast).
let activeSchedule: readonly number[] = RETRY_SCHEDULE_MS

// Test hook: schedule override (null = back to the real one).
export function setRetryScheduleOverride(schedule: readonly number[] | null): void {
  activeSchedule = schedule ?? RETRY_SCHEDULE_MS
}

export function getActiveSchedule(): readonly number[] {
  return activeSchedule
}

export function getMaxAttempts(): number {
  return activeSchedule.length
}

// Returns the delay (ms) before attempt `attempt`, with jitter.
// injectable rng → deterministic in tests.
export function backoffMs(attempt: number, rng: () => number = Math.random): number {
  if (attempt < 1) throw new Error(`attempt must be >= 1, got ${attempt}`)
  if (attempt > activeSchedule.length) {
    throw new Error(`attempt ${attempt} out of schedule (max ${activeSchedule.length})`)
  }
  const base = activeSchedule[attempt - 1] ?? 0
  if (base === 0) return 0
  // ⭐ JITTER: multiply by a random factor in [0.8, 1.2].
  // Without it, all events would retry at EXACTLY the same time (thundering herd).
  const factor = 1 - JITTER_RATIO + 2 * JITTER_RATIO * rng()
  return Math.round(base * factor)
}
