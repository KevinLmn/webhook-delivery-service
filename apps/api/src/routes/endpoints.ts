import { CreateEndpointSchema, EndpointIdSchema } from '@vitrine/core'
import type { FastifyPluginAsync } from 'fastify'
import { archiveEndpoint, createEndpoint, listEndpoints } from '../services/endpoints'

export const endpointsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/endpoints', async (request, reply) => {
    if (!request.clientId) return reply.code(401).send({ error: 'unauthorized' })
    const parsed = CreateEndpointSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues })
    }

    const created = await createEndpoint({
      db: app.db,
      clientId: request.clientId,
      url: parsed.data.url,
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      masterKey: app.config.masterKey,
    })
    return reply.code(201).send({
      id: created.id,
      url: created.url,
      description: created.description,
      secret: created.secret,
      created_at: created.createdAt,
    })
  })

  app.get('/endpoints', async (request, reply) => {
    if (!request.clientId) return reply.code(401).send({ error: 'unauthorized' })
    const list = await listEndpoints(app.db, request.clientId)
    return list.map((e) => ({
      id: e.id,
      url: e.url,
      description: e.description,
      created_at: e.createdAt,
    }))
  })

  app.delete<{ Params: { id: string } }>('/endpoints/:id', async (request, reply) => {
    if (!request.clientId) return reply.code(401).send({ error: 'unauthorized' })
    const id = EndpointIdSchema.safeParse(request.params.id)
    if (!id.success) return reply.code(404).send({ error: 'not_found' })
    const ok = await archiveEndpoint(app.db, request.clientId, id.data)
    if (!ok) return reply.code(404).send({ error: 'not_found' })
    return reply.code(204).send()
  })
}
