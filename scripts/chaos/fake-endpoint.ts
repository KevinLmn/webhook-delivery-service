import Fastify, { type FastifyInstance } from 'fastify'

export interface PhaseConfig {
  /** ms since startTime at which this phase takes effect */
  startMs: number
  /** Endpoint behavior during this phase */
  behavior:
    | { kind: 'ok' }
    | { kind: 'fail'; statusCode: number }
    | { kind: 'mixed'; failRatio: number; failStatusCode: number }
}

export interface FakeEndpoint {
  url: string
  /** (Re)starts the phase clock: call it when the run actually starts, not at boot */
  startClock: () => void
  /** Cumulative number of requests received */
  totalReceived: () => number
  /** Active phase at a given instant (to annotate the PNG) */
  phaseAt: (ms: number) => number
  close: () => Promise<void>
}

export const CHAOS_PHASES: PhaseConfig[] = [
  { startMs: 0, behavior: { kind: 'ok' } },
  { startMs: 10_000, behavior: { kind: 'fail', statusCode: 500 } },
  { startMs: 40_000, behavior: { kind: 'mixed', failRatio: 0.5, failStatusCode: 500 } },
  { startMs: 80_000, behavior: { kind: 'ok' } },
]

function activeBehavior(elapsedMs: number, phases: PhaseConfig[]): PhaseConfig['behavior'] {
  let active = phases[0]!.behavior
  for (const phase of phases) {
    if (elapsedMs >= phase.startMs) active = phase.behavior
  }
  return active
}

export async function startChaosFakeEndpoint(opts: {
  phases?: PhaseConfig[]
  port?: number
}): Promise<FakeEndpoint> {
  const phases = opts.phases ?? CHAOS_PHASES
  let startedAt = Date.now()
  let totalReceived = 0

  const app: FastifyInstance = Fastify({ logger: false })

  app.post('/hook', async (req, reply) => {
    totalReceived++
    const elapsedMs = Date.now() - startedAt
    const behavior = activeBehavior(elapsedMs, phases)

    if (behavior.kind === 'fail') {
      return reply.code(behavior.statusCode).send({ error: 'fail' })
    }
    if (behavior.kind === 'mixed') {
      // Random, so this CLI run varies from one run to the next. The public demo
      // (apps/demo/src/scenario.ts) uses a deterministic pattern instead.
      const fail = Math.random() < behavior.failRatio
      if (fail) return reply.code(behavior.failStatusCode).send({ error: 'fail' })
      return reply.code(200).send({ ok: true })
    }
    return reply.code(200).send({ ok: true })
  })

  // 0.0.0.0 so it's reachable from the worker container via host.docker.internal
  await app.listen({ host: '0.0.0.0', port: opts.port ?? 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('listen failed')

  // The URL given to the API must point to the host from inside the Docker
  // worker. On Docker Desktop (mac/win), `host.docker.internal` resolves to the host.
  // On Linux, we use `--add-host=host.docker.internal:host-gateway` in the compose file.
  const url = `http://host.docker.internal:${address.port}/hook`

  return {
    url,
    startClock: () => {
      startedAt = Date.now()
    },
    totalReceived: () => totalReceived,
    phaseAt: (ms) => {
      let idx = 0
      for (let i = 0; i < phases.length; i++) {
        if (ms >= phases[i]!.startMs) idx = i
      }
      return idx + 1
    },
    close: async () => {
      await app.close()
    },
  }
}
