import type { FastifyPluginAsync } from 'fastify'
import { replayEvent } from '../services/replay'

export const replayRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>('/events/:id/replay', async (request, reply) => {
    if (!request.clientId) return reply.code(401).send({ error: 'unauthorized' })
    const result = await replayEvent({
      db: app.db,
      queue: app.deliveryQueue,
      clientId: request.clientId,
      eventId: request.params.id,
    })
    if (result.kind === 'not_found') return reply.code(404).send({ error: 'not_found' })
    if (result.kind === 'conflict_pending') {
      return reply.code(409).send({ error: 'event_pending' })
    }
    return reply.code(200).send({ id: request.params.id, status: 'pending' })
  })
}
