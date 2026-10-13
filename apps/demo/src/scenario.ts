// ============================================================================
//  scenario.ts — The outage scenario played by the fake endpoint.
//  Pure functions only: given "ms since run start" (+ a request counter), what
//  does the endpoint answer? Shared with the browser through /api/state.
// ============================================================================

export const TOTAL_EVENTS = 1000
export const PUSH_DURATION_MS = 90_000 // events are spread so traffic keeps flowing through the outage
export const RUN_DURATION_MS = 140_000 // 110s of phases + 30s to drain retries
export const POISON_EVERY = 25 // every 25th event carries a payload the endpoint rejects (422)

export type PhaseKind = 'ok' | 'fail' | 'mixed'

export interface Phase {
  startMs: number
  endMs: number
  kind: PhaseKind
  label: string
  /** One sentence shown in the UI while the phase is active */
  description: string
}

export const PHASES: Phase[] = [
  {
    startMs: 0,
    endMs: 10_000,
    kind: 'ok',
    label: 'Healthy',
    description: 'The endpoint answers 200. Events are delivered on the first attempt.',
  },
  {
    startMs: 10_000,
    endMs: 40_000,
    kind: 'fail',
    label: 'Outage · 500',
    description:
      'Every request fails. After 5 consecutive failures the circuit breaker opens and the worker stops calling the endpoint: events wait in the queue instead of burning retries.',
  },
  {
    startMs: 40_000,
    endMs: 70_000,
    kind: 'mixed',
    label: 'Flaky · 1 in 3 fails',
    description:
      'One request in three fails. The breaker probes (half_open) and closes again; failures are scattered, so it stays closed while exponential backoff retries absorb them.',
  },
  {
    startMs: 70_000,
    endMs: RUN_DURATION_MS,
    kind: 'ok',
    label: 'Recovered',
    description: 'The endpoint is healthy again. The backlog drains as scheduled retries come due.',
  },
]

export function phaseIndexAt(elapsedMs: number): number {
  let idx = 0
  for (let i = 0; i < PHASES.length; i++) {
    const phase = PHASES[i]
    if (phase && elapsedMs >= phase.startMs) idx = i
  }
  return idx
}

export function isPoison(eventIndex: number): boolean {
  return (eventIndex + 1) % POISON_EVERY === 0
}

export function phaseKindAt(elapsedMs: number): PhaseKind {
  return PHASES[phaseIndexAt(elapsedMs)]?.kind ?? 'ok'
}

/**
 * Status code the fake endpoint returns.
 * An outage wins over everything (the server is down before it reads the body);
 * otherwise a poison payload is rejected with 422, a terminal 4xx.
 * In the flaky phase, `flakySeq` (n-th request of that phase) fails every third
 * request. Deterministic on purpose: the first request, the breaker's probe,
 * succeeds, and failures never line up 5 in a row, so every run tells the same story.
 */
export function respond(opts: { elapsedMs: number; poison: boolean; flakySeq: number }): number {
  const kind = phaseKindAt(opts.elapsedMs)
  if (kind === 'fail') return 500
  if (opts.poison) return 422
  if (kind === 'mixed' && opts.flakySeq % 3 === 2) return 500
  return 200
}

/** When event #i is pushed, relative to run start */
export function pushOffsetMs(eventIndex: number): number {
  return Math.round((eventIndex * PUSH_DURATION_MS) / TOTAL_EVENTS)
}
