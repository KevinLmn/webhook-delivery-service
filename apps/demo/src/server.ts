// ============================================================================
//  server.ts — The public demo service.
//  - serves the page (public/)
//  - POST /api/runs  : start the outage scenario (one at a time, rate limited)
//  - GET  /api/stream: Server-Sent Events, every visitor sees the same run live
//  It talks to the real API over HTTP to ingest events, and reads Postgres +
//  Redis to observe what the worker does. The fake customer endpoint runs on a
//  separate internal port (hook-server.ts).
// ============================================================================
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashApiKey, newId } from '@vitrine/core'
import { clients, createDbClient } from '@vitrine/db'
import Fastify from 'fastify'
import IORedis from 'ioredis'
import pino from 'pino'
import { startHookServer } from './hook-server'
import { CooldownLimiter } from './rate-limit'
import { RunManager, type RunMessage } from './run-manager'
import { PHASES, POISON_EVERY, PUSH_DURATION_MS, RUN_DURATION_MS, TOTAL_EVENTS } from './scenario'

const RUN_COOLDOWN_PER_IP_MS = 3 * 60_000
const MAX_STREAMS = 300
const HEARTBEAT_MS = 15_000

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const env = {
  databaseUrl: requireEnv('DATABASE_URL'),
  redisUrl: requireEnv('REDIS_URL'),
  masterKey: Buffer.from(requireEnv('MASTER_ENCRYPTION_KEY'), 'base64'),
  apiBaseUrl: requireEnv('DEMO_API_URL'), // e.g. http://api:3000 (internal)
  hookBaseUrl: requireEnv('DEMO_HOOK_URL'), // e.g. http://demo:3200 (internal, reachable by the worker)
  port: Number(process.env.PORT ?? 3100),
  hookPort: Number(process.env.HOOK_PORT ?? 3200),
  repoUrl: process.env.DEMO_REPO_URL ?? 'https://github.com/KevinLmn/webhook-delivery-service',
  logLevel: process.env.LOG_LEVEL ?? 'info',
}

const logger = pino({ level: env.logLevel })
const db = createDbClient(env.databaseUrl)
const redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null })

// A fresh demo tenant per boot: the plaintext API key only ever lives in this process.
const apiKey = `cl_secret_${randomBytes(24).toString('base64url')}`
const clientId = newId('cl')
await db
  .insert(clients)
  .values({ id: clientId, name: 'public-demo', apiKeyHash: await hashApiKey(apiKey) })

const runs = new RunManager({
  db,
  redis,
  masterKey: env.masterKey,
  apiBaseUrl: env.apiBaseUrl,
  apiKey,
  clientId,
  hookBaseUrl: env.hookBaseUrl,
  logger,
})
await runs.restoreLastRun()
const hookServer = await startHookServer({ port: env.hookPort, findRun: runs.findHookTarget })
const limiter = new CooldownLimiter(RUN_COOLDOWN_PER_IP_MS)

// --- static files, loaded once ------------------------------------------------
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
}
const assets = new Map<string, { body: Buffer; type: string }>()
for (const [route, { file, type }] of Object.entries(STATIC)) {
  assets.set(route, { body: await readFile(path.join(publicDir, file)), type })
}
// Cache busting: index.html references /app.js?v=<hash>, so a deploy is picked up immediately.
const version = createHash('sha256')
  .update(Buffer.concat([...assets.values()].map((a) => a.body)))
  .digest('hex')
  .slice(0, 10)
const index = assets.get('/')
if (index) {
  const html = index.body
    .toString('utf8')
    .replace('/styles.css', `/styles.css?v=${version}`)
    .replace('/app.js', `/app.js?v=${version}`)
  assets.set('/', { ...index, body: Buffer.from(html) })
}

// trustProxy: Caddy sits in front, request.ip must be the visitor's, not the proxy's.
const app = Fastify({ logger: { level: env.logLevel }, trustProxy: true })

app.addHook('onSend', async (_request, reply) => {
  reply.header('x-content-type-options', 'nosniff')
  reply.header('referrer-policy', 'no-referrer')
  reply.header('x-frame-options', 'DENY')
  reply.header(
    'content-security-policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self' https://kevinlemniai.fr; connect-src 'self' https://kevinlemniai.fr; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  )
})

for (const route of assets.keys()) {
  app.get(route, async (_request, reply) => {
    const asset = assets.get(route)
    if (!asset) return reply.code(404).send()
    // The page itself is never cached; versioned assets can be cached for a long time.
    const cache = route === '/' ? 'no-cache' : 'public, max-age=31536000, immutable'
    return reply.type(asset.type).header('cache-control', cache).send(asset.body)
  })
}

app.get('/health', async () => ({ ok: true }))

// Static config the page needs to draw the timeline.
app.get('/api/config', async () => ({
  phases: PHASES,
  totalEvents: TOTAL_EVENTS,
  runDurationMs: RUN_DURATION_MS,
  pushDurationMs: PUSH_DURATION_MS,
  poisonEvery: POISON_EVERY,
  repoUrl: env.repoUrl,
}))

app.get('/api/state', async () => runs.snapshot())

app.post('/api/runs', async (request, reply) => {
  if (runs.isRunning()) {
    return reply.code(409).send({ error: 'run_in_progress' })
  }
  const waitMs = limiter.tryAcquire(request.ip, Date.now())
  if (waitMs > 0) {
    return reply
      .code(429)
      .header('retry-after', String(Math.ceil(waitMs / 1000)))
      .send({ error: 'cooldown', retry_after_ms: waitMs })
  }
  const result = await runs.start()
  return reply.code(result.started ? 201 : 409).send({ run_id: result.runId })
})

let openStreams = 0
app.get('/api/stream', (request, reply) => {
  if (openStreams >= MAX_STREAMS) {
    return reply.code(503).send({ error: 'too_many_viewers' })
  }
  openStreams++
  reply.hijack()
  const res = reply.raw
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (msg: RunMessage) => {
    res.write(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`)
  }
  send(runs.snapshot())
  const unsubscribe = runs.subscribe(send)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)

  request.raw.on('close', () => {
    openStreams--
    clearInterval(heartbeat)
    unsubscribe()
  })
})

const shutdown = async () => {
  runs.stop()
  await app.close()
  await hookServer.close()
  await redis.quit()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

await app.listen({ host: '0.0.0.0', port: env.port })
