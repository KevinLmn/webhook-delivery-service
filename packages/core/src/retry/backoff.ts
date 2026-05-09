export const RETRY_SCHEDULE_MS = [
  0,            // attempt 1: immediate
  1_000,        // attempt 2: 1s
  10_000,       // attempt 3: 10s
  60_000,       // attempt 4: 1min
  600_000,      // attempt 5: 10min
  3_600_000,    // attempt 6: 1h
  21_600_000    // attempt 7: 6h
] as const

export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length
export const JITTER_RATIO = 0.2

let activeSchedule: readonly number[] = RETRY_SCHEDULE_MS

export function setRetryScheduleOverride(schedule: readonly number[] | null): void {
  activeSchedule = schedule ?? RETRY_SCHEDULE_MS
}

export function getActiveSchedule(): readonly number[] {
  return activeSchedule
}

export function getMaxAttempts(): number {
  return activeSchedule.length
}

export function backoffMs(attempt: number, rng: () => number = Math.random): number {
  if (attempt < 1) throw new Error(`attempt must be >= 1, got ${attempt}`)
  if (attempt > activeSchedule.length) {
    throw new Error(`attempt ${attempt} out of schedule (max ${activeSchedule.length})`)
  }
  const base = activeSchedule[attempt - 1] ?? 0
  if (base === 0) return 0
  const factor = 1 - JITTER_RATIO + 2 * JITTER_RATIO * rng()
  return Math.round(base * factor)
}
