// ============================================================================
//  hook-server.ts — The fake CUSTOMER endpoint the worker delivers to.
//  Runs on an internal port only (never exposed publicly). Like a real
//  consumer, it verifies the Standard Webhooks signature before answering,
//  then plays the scenario (200 / 500 / 422 depending on the phase).
// ============================================================================
import { verifyWebhookSignature } from '@vitrine/core'
import Fastify, { type FastifyInstance } from 'fastify'
import { phaseKindAt, respond } from './scenario'

export interface HookTarget {
  startedAt: number
  secret: string
  stats: { received: number; verified: number; rejected: number }
  /** Requests answered during the flaky phase, drives its failure pattern */
  flakySeq: number
}

export async function startHookServer(opts: {
  port: number
  findRun: (runId: string) => HookTarget | null
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 })

  // Keep the raw body: the signature covers the exact bytes, not a re-serialized object.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })

  app.post<{ Params: { runId: string } }>('/hook/:runId', async (request, reply) => {
    const run = opts.findRun(request.params.runId)
    if (!run) return reply.code(410).send({ error: 'unknown_run' })
    run.stats.received++

    const body = typeof request.body === 'string' ? request.body : ''
    const id = request.headers['webhook-id']
    const timestamp = Number(request.headers['webhook-timestamp'])
    const signature = request.headers['webhook-signature']
    const valid =
      typeof id === 'string' &&
      typeof signature === 'string' &&
      Number.isFinite(timestamp) &&
      verifyWebhookSignature({ secret: run.secret, id, timestamp, body, signature })
    if (!valid) {
      run.stats.rejected++
      return reply.code(401).send({ error: 'bad_signature' })
    }
    run.stats.verified++

    let poison = false
    try {
      poison = (JSON.parse(body) as { poison?: unknown }).poison === true
    } catch {
      // not JSON: treat as a regular payload
    }

    const elapsedMs = Date.now() - run.startedAt
    const flakySeq = phaseKindAt(elapsedMs) === 'mixed' ? run.flakySeq++ : 0
    const status = respond({ elapsedMs, poison, flakySeq })
    return reply.code(status).send(status === 200 ? { ok: true } : { error: `scenario_${status}` })
  })

  await app.listen({ host: '0.0.0.0', port: opts.port })
  return app
}
