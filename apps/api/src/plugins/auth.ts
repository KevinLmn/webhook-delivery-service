import { createHash } from 'node:crypto'
import { verifyApiKey } from '@vitrine/core'
import { clients } from '@vitrine/db'
import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyRequest {
    clientId?: string
  }
}

// argon2 is deliberately slow (~20-40ms). Once a token has been verified, remember
// it by its SHA-256 for a few minutes so a client sending 10+ req/s doesn't burn a
// CPU core re-verifying the same key. A revoked key keeps working until its entry expires.
const AUTH_CACHE_TTL_MS = 5 * 60_000
const AUTH_CACHE_MAX = 1_000

/**
 * Bearer token authentication.
 *
 * Cache miss: linear scan of the `clients` table, calling argon2 verify against
 * each row. Acceptable for a handful of clients. To scale the miss path, prefix
 * the token with a client id hint (e.g. `cl_secret_<id_hint>_<rest>`) so we can
 * short-circuit to a direct lookup.
 */
export const authPlugin = fp(async (app) => {
  app.decorateRequest('clientId', undefined)
  const verified = new Map<string, { clientId: string; expiresAt: number }>()

  app.addHook('preHandler', async (request, reply) => {
    const routeUrl = request.routeOptions.url ?? request.url
    if (routeUrl === '/health' || routeUrl === '/ready') return

    const header = request.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const token = header.slice(7).trim()
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized' })
    }

    const digest = createHash('sha256').update(token).digest('hex')
    const now = Date.now()
    const hit = verified.get(digest)
    if (hit && hit.expiresAt > now) {
      request.clientId = hit.clientId
      return
    }

    const all = await app.db.select().from(clients)
    for (const c of all) {
      if (await verifyApiKey(c.apiKeyHash, token)) {
        if (verified.size >= AUTH_CACHE_MAX) verified.clear()
        verified.set(digest, { clientId: c.id, expiresAt: now + AUTH_CACHE_TTL_MS })
        request.clientId = c.id
        return
      }
    }
    return reply.code(401).send({ error: 'unauthorized' })
  })
})
