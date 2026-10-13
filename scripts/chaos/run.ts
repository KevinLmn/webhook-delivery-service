import { setTimeout as sleep } from 'node:timers/promises'
import { request } from 'undici'
import { CHAOS_PHASES, startChaosFakeEndpoint } from './fake-endpoint.ts'
import { bootChaosStack } from './orchestrator.ts'
import { sampleOnce, type Sample } from './collector.ts'
import { renderChaosPng } from './render-png.ts'

const TOTAL_EVENTS = 100
const PUSH_DURATION_MS = 90_000  // spread across all phases so traffic hits the outage
const RUN_DURATION_MS = 140_000  // 110 s phases + 30 s drain
const SAMPLE_INTERVAL_MS = 1_000

function fileStem(now: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes())
  ].join('-').replace(/-(?=\d{2}$)/, '-')  // 2026-05-10-14-32
}

async function pushEvents(opts: {
  apiBaseUrl: string
  apiKey: string
  endpointId: string
  total: number
  durationMs: number
}) {
  const interval = opts.durationMs / opts.total
  const tasks: Promise<void>[] = []
  for (let i = 0; i < opts.total; i++) {
    const t = Date.now()
    const task = (async () => {
      const r = await request(`${opts.apiBaseUrl}/events`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${opts.apiKey}`,
          'Idempotency-Key': `chaos-${i}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          endpoint_id: opts.endpointId,
          event_type: 'chaos.demo',
          payload: { i, ts: Date.now() }
        })
      })
      await r.body.dump()
      if (r.statusCode !== 202 && r.statusCode !== 200) {
        // eslint-disable-next-line no-console
        console.warn(`[push] event ${i}: status ${r.statusCode}`)
      }
    })()
    tasks.push(task)
    const elapsed = Date.now() - t
    if (elapsed < interval) await sleep(interval - elapsed)
  }
  await Promise.all(tasks)
}

async function main() {
  // eslint-disable-next-line no-console
  const log = (msg: string) => console.log(`[chaos] ${new Date().toISOString()} ${msg}`)

  log('starting fake endpoint')
  const fake = await startChaosFakeEndpoint({})
  log(`fake endpoint at ${fake.url}`)

  log('booting stack (docker compose up --build)')
  const stack = await bootChaosStack({ endpointUrl: fake.url })
  log(`stack ready, api at ${stack.apiBaseUrl}, endpoint=${stack.endpointId}`)

  // Phases are relative to the run start, not to the fake endpoint boot
  // (the docker stack takes ~15s to come up in between).
  fake.startClock()
  const runStartedAt = Date.now()
  const samples: Sample[] = []

  // push the events during the first window
  log(`pushing ${TOTAL_EVENTS} events over ${PUSH_DURATION_MS}ms`)
  const pushPromise = pushEvents({
    apiBaseUrl: stack.apiBaseUrl,
    apiKey: stack.apiKey,
    endpointId: stack.endpointId,
    total: TOTAL_EVENTS,
    durationMs: PUSH_DURATION_MS
  })

  // sample for the whole duration
  let nextTick = Date.now()
  while (Date.now() - runStartedAt < RUN_DURATION_MS) {
    nextTick += SAMPLE_INTERVAL_MS
    const sample = await sampleOnce({
      db: stack.db,
      redis: stack.redis,
      endpointId: stack.endpointId,
      runStartedAt,
      windowMs: 2_000
    })
    samples.push(sample)
    log(
      `t=${(sample.tMs / 1000).toFixed(0).padStart(3, ' ')}s ` +
        `delivered=${sample.delivered} pending=${sample.pending} dead=${sample.dead} ` +
        `breaker=${sample.breakerState} skipCount=${sample.breakerSkipCount} ` +
        `p50=${sample.p50LatencyMs ?? '—'}ms p99=${sample.p99LatencyMs ?? '—'}ms`
    )
    const sleepMs = Math.max(0, nextTick - Date.now())
    await sleep(sleepMs)
  }

  await pushPromise
  log('run finished, generating PNG')

  const phases = CHAOS_PHASES.map((p, i, arr) => {
    const next = arr[i + 1]
    return {
      startMs: p.startMs,
      endMs: next ? next.startMs : RUN_DURATION_MS,
      label:
        p.behavior.kind === 'ok'
          ? `phase ${i + 1} (200 OK)`
          : p.behavior.kind === 'fail'
            ? `phase ${i + 1} (${p.behavior.statusCode})`
            : `phase ${i + 1} (mixed)`,
      fillColor:
        p.behavior.kind === 'ok'
          ? 'rgba(34,197,94,0.08)'
          : p.behavior.kind === 'fail'
            ? 'rgba(220,38,38,0.08)'
            : 'rgba(245,158,11,0.08)'
    }
  })

  const stem = fileStem(new Date())
  const pngPath = await renderChaosPng({
    samples,
    phases,
    totalEvents: TOTAL_EVENTS,
    outDir: 'docs/chaos-runs',
    fileStem: stem
  })
  log(`PNG written to ${pngPath}`)

  log('tearing down')
  await fake.close()
  await stack.teardown()
  log('done')
  // eslint-disable-next-line no-console
  console.log(pngPath)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
