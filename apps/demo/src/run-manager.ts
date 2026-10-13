// ============================================================================
//  run-manager.ts — Owns the (single) active demo run.
//  One run at a time for everyone: visitors who arrive mid-run watch the same
//  run live. Each run gets a FRESH endpoint, so it starts with a closed breaker
//  and an empty history.
// ============================================================================
import { randomBytes } from 'node:crypto'
import { encryptSecret, newId } from '@vitrine/core'
import { type DbClient, endpoints } from '@vitrine/db'
import type { Redis } from 'ioredis'
import type { Logger } from 'pino'
import { request } from 'undici'
import type { HookTarget } from './hook-server'
import { type Attempt, type Sample, recentAttempts, sampleEndpoint } from './sampler'
import { RUN_DURATION_MS, TOTAL_EVENTS, isPoison, pushOffsetMs } from './scenario'

const TICK_MS = 1_000
const LAST_RUN_KEY = 'demo:last_run' // survives restarts/deploys, so the page is never empty
const MAX_ATTEMPTS_KEPT = 400

export type RunStatus = 'running' | 'finished' | 'failed'

export interface PublicRun {
  id: string
  status: RunStatus
  startedAt: number
  elapsedMs: number
  pushed: number
  accepted: number
  hook: HookTarget['stats']
  samples: Sample[]
  attempts: Attempt[]
}

export type RunMessage =
  | { type: 'snapshot'; run: PublicRun | null }
  | {
      type: 'tick'
      runId: string
      status: RunStatus
      elapsedMs: number
      pushed: number
      accepted: number
      hook: HookTarget['stats']
      sample: Sample
      attempts: Attempt[]
    }

interface Run extends HookTarget {
  id: string
  endpointId: string
  status: RunStatus
  pushed: number
  accepted: number
  samples: Sample[]
  attempts: Attempt[]
  seenAttempts: Set<string>
  timers: NodeJS.Timeout[]
}

export interface RunManagerDeps {
  db: DbClient
  redis: Redis
  masterKey: Buffer
  apiBaseUrl: string
  apiKey: string
  clientId: string
  hookBaseUrl: string
  logger: Logger
}

export class RunManager {
  private current: Run | null = null
  private restored: PublicRun | null = null // last finished run, loaded from Redis at boot
  private starting = false // guards the async gap between "check" and "current = run"
  private readonly runs = new Map<string, Run>() // current + last, for late webhook deliveries
  private readonly listeners = new Set<(msg: RunMessage) => void>()

  constructor(private readonly deps: RunManagerDeps) {}

  isRunning(): boolean {
    return this.starting || this.current?.status === 'running'
  }

  findHookTarget = (runId: string): HookTarget | null => this.runs.get(runId) ?? null

  subscribe(listener: (msg: RunMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): RunMessage {
    return { type: 'snapshot', run: this.current ? this.toPublic(this.current) : this.restored }
  }

  async restoreLastRun(): Promise<void> {
    const raw = await this.deps.redis.get(LAST_RUN_KEY)
    if (!raw) return
    try {
      this.restored = JSON.parse(raw) as PublicRun
    } catch {
      // corrupted entry: start empty
    }
  }

  /** Starts a run unless one is already going. Returns the run id. */
  async start(): Promise<{ started: boolean; runId: string }> {
    if (this.current?.status === 'running') return { started: false, runId: this.current.id }
    if (this.starting) return { started: false, runId: '' }
    this.starting = true
    try {
      return await this.createRun()
    } finally {
      this.starting = false
    }
  }

  private async createRun(): Promise<{ started: boolean; runId: string }> {
    const id = `run_${randomBytes(8).toString('hex')}`
    const secret = `whsec_${randomBytes(24).toString('base64url')}`
    const endpointId = newId('ep')
    // Inserted directly: the public API only accepts https URLs, and this
    // endpoint lives on the internal docker network (plain http).
    await this.deps.db.insert(endpoints).values({
      id: endpointId,
      clientId: this.deps.clientId,
      url: `${this.deps.hookBaseUrl}/hook/${id}`,
      secretEncrypted: encryptSecret(secret, this.deps.masterKey),
      description: `public demo run ${id}`,
    })

    const run: Run = {
      id,
      endpointId,
      secret,
      startedAt: Date.now(),
      status: 'running',
      stats: { received: 0, verified: 0, rejected: 0 },
      pushed: 0,
      accepted: 0,
      samples: [],
      attempts: [],
      seenAttempts: new Set(),
      timers: [],
    }

    // Keep only the previous run around (its retries may still be in flight).
    for (const old of this.runs.values()) {
      if (old.id !== this.current?.id) this.runs.delete(old.id)
    }
    this.runs.set(id, run)
    this.current = run
    this.deps.logger.info({ runId: id, endpointId }, 'demo run started')

    for (let i = 0; i < TOTAL_EVENTS; i++) {
      run.timers.push(setTimeout(() => void this.pushEvent(run, i), pushOffsetMs(i)))
    }
    this.scheduleTick(run)
    this.broadcast(this.snapshot())
    return { started: true, runId: id }
  }

  stop(): void {
    if (!this.current) return
    for (const t of this.current.timers) clearTimeout(t)
  }

  private async pushEvent(run: Run, i: number): Promise<void> {
    run.pushed++
    try {
      const res = await request(`${this.deps.apiBaseUrl}/events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.deps.apiKey}`,
          'idempotency-key': `${run.id}-${i}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          endpoint_id: run.endpointId,
          event_type: 'order.created',
          payload: {
            order_id: `ord_${String(i + 1).padStart(3, '0')}`,
            amount_cents: 1_000 + ((i * 737) % 9_000),
            ...(isPoison(i) ? { poison: true } : {}),
          },
        }),
      })
      await res.body.dump()
      if (res.statusCode === 202 || res.statusCode === 200) run.accepted++
      else this.deps.logger.warn({ runId: run.id, i, status: res.statusCode }, 'push rejected')
    } catch (err) {
      this.deps.logger.error({ err, runId: run.id, i }, 'push failed')
    }
  }

  private scheduleTick(run: Run): void {
    let next = run.startedAt
    const loop = async () => {
      await this.tick(run).catch((err) => {
        this.deps.logger.error({ err, runId: run.id }, 'tick failed')
      })
      if (run.status !== 'running') return
      next += TICK_MS
      run.timers.push(setTimeout(loop, Math.max(0, next - Date.now())))
    }
    void loop()
  }

  private async tick(run: Run): Promise<void> {
    const now = Date.now()
    const ctx = { db: this.deps.db, endpointId: run.endpointId, runStartedAt: run.startedAt }
    const [sample, attempts] = await Promise.all([
      sampleEndpoint({ ...ctx, redis: this.deps.redis, now }),
      recentAttempts({ ...ctx, since: now - 3 * TICK_MS }),
    ])

    const fresh = attempts.filter((a) => !run.seenAttempts.has(a.id))
    for (const a of fresh) run.seenAttempts.add(a.id)
    run.attempts.push(...fresh)
    if (run.attempts.length > MAX_ATTEMPTS_KEPT)
      run.attempts.splice(0, run.attempts.length - MAX_ATTEMPTS_KEPT)
    run.samples.push(sample)

    if (sample.t >= RUN_DURATION_MS) {
      run.status = 'finished'
      await this.deps.redis.set(LAST_RUN_KEY, JSON.stringify(this.toPublic(run)))
      this.deps.logger.info(
        { runId: run.id, delivered: sample.delivered, dead: sample.dead, pending: sample.pending },
        'demo run finished',
      )
    }

    this.broadcast({
      type: 'tick',
      runId: run.id,
      status: run.status,
      elapsedMs: sample.t,
      pushed: run.pushed,
      accepted: run.accepted,
      hook: run.stats,
      sample,
      attempts: fresh,
    })
  }

  private toPublic(run: Run): PublicRun {
    return {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      elapsedMs: Math.min(Date.now() - run.startedAt, RUN_DURATION_MS),
      pushed: run.pushed,
      accepted: run.accepted,
      hook: run.stats,
      samples: run.samples,
      attempts: run.attempts,
    }
  }

  private broadcast(msg: RunMessage): void {
    for (const listener of this.listeners) listener(msg)
  }
}
