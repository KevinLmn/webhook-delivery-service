import { verifyApiKey } from '@vitrine/core'
import { clients } from '@vitrine/db'
import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyRequest {
    clientId?: string
  }
}

/**
 * Bearer token authentication.
 *
 * V1 limitation: linear scan of the `clients` table on every authenticated
 * request, calling argon2 verify against each row. Acceptable for the demo
 * (~10 clients). To optimise in V2, prefix the token with a client id hint
 * (e.g. `cl_secret_<id_hint>_<rest>`) so we can short-circuit to a direct
 * lookup.
 */
export const authPlugin = fp(async (app) => {
  app.decorateRequest('clientId', undefined)

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

    const all = await app.db.select().from(clients)
    for (const c of all) {
      if (await verifyApiKey(c.apiKeyHash, token)) {
        request.clientId = c.id
        return
      }
    }
    return reply.code(401).send({ error: 'unauthorized' })
  })
})
