import Fastify, { type FastifyInstance } from 'fastify'

export type ResponseSpec =
  | { kind: 'ok'; statusCode?: number }
  | { kind: 'fail'; statusCode: number }
  | { kind: 'timeout'; delayMs: number }
  | { kind: 'throttle'; retryAfter: string }

interface ReceivedRequest {
  headers: Record<string, string | string[] | undefined>
  body: unknown
  receivedAt: number
}

export interface FakeEndpoint {
  url: string
  setResponse: (spec: ResponseSpec) => void
  received: () => ReceivedRequest[]
  reset: () => void
  close: () => Promise<void>
}

export async function startFakeEndpoint(): Promise<FakeEndpoint> {
  const app: FastifyInstance = Fastify({ logger: false })
  let spec: ResponseSpec = { kind: 'ok' }
  const received: ReceivedRequest[] = []

  app.post('/hook', async (req, reply) => {
    received.push({ headers: req.headers, body: req.body, receivedAt: Date.now() })

    const current = spec
    if (current.kind === 'timeout') {
      await new Promise((r) => setTimeout(r, current.delayMs))
      return reply.code(200).send({ ok: true })
    }
    if (current.kind === 'fail') return reply.code(current.statusCode).send({ error: 'fail' })
    if (current.kind === 'throttle') {
      reply.header('Retry-After', current.retryAfter)
      return reply.code(429).send({ error: 'rate_limit' })
    }
    return reply.code(current.statusCode ?? 200).send({ ok: true })
  })

  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('listen failed')
  const url = `http://127.0.0.1:${address.port}/hook`

  return {
    url,
    setResponse: (s) => {
      spec = s
    },
    received: () => received.slice(),
    reset: () => {
      received.length = 0
      spec = { kind: 'ok' }
    },
    close: async () => {
      await app.close()
    },
  }
}
