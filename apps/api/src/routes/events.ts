import { IngestEventSchema } from '@vitrine/core'
import { type DbClient, deliveryAttempts, endpoints, events } from '@vitrine/db'
import { type SQL, and, desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { ingestEvent } from '../services/ingestion'

interface EventsListQuery {
  status?: string
  endpoint_id?: string
  limit?: string
}

export const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/events', async (request, reply) => {
    if (!request.clientId) return reply.code(401).send({ error: 'unauthorized' })

    const idemKey = request.headers['idempotency-key']
    if (typeof idemKey !== 'string' || idemKey.length === 0) {
      return reply.code(400).send({ error: 'idempotency_key_required' })
    }

    const parsed = IngestEventSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues })
    }

    const result = await ingestEvent({
      db: app.db,
      redis: app.redis,
      queue: app.deliveryQueue,
      clientId: request.clientId,
      endpointId: parsed.data.endpoint_id,
      eventType: parsed.data.event_type,
      payload: parsed.data.payload,
      idempotencyKey: idemKey
    })

    if (result.kind === 'endpoint_not_found') {
      return reply.code(404).send({ error: 'endpoint_not_found' })
    }
    if (result.kind === 'conflict') {
      return reply.code(422).send({ error: 'idempotency_conflict' })
    }
    const status = result.kind === 'created' ? 202 : 200
    return reply.code(status).send({
      id: result.eventId,
      status: 'pending',
      endpoint_id: parsed.data.endpoint_id
    })
  })

  app.get<{ Querystring: EventsListQuery }>('/events', async (request, reply) => {
    if (!request.clientId) return reply.code(401).send({ error: 'unauthorized' })
    const rows = await listEventsForClient(app.db, request.clientId, request.query)
    return rows
  })

  app.get<{ Params: { id: string } }>('/events/:id', async (request, reply) => {
    if (!request.clientId) return reply.code(401).send({ error: 'unauthorized' })
    const detail = await findEventDetail(app.db, request.clientId, request.params.id)
    if (!detail) return reply.code(404).send({ error: 'not_found' })
    return detail
  })
}

async function listEventsForClient(db: DbClient, clientId: string, query: EventsListQuery) {
  const filters: SQL[] = [eq(endpoints.clientId, clientId)]
  if (query.status === 'pending' || query.status === 'delivered' || query.status === 'dead') {
    filters.push(eq(events.status, query.status))
  }
  if (query.endpoint_id) {
    filters.push(eq(events.endpointId, query.endpoint_id))
  }
  const limit = Math.min(Number(query.limit ?? 50), 200)

  return db
    .select({
      id: events.id,
      endpoint_id: events.endpointId,
      event_type: events.eventType,
      status: events.status,
      delivered_at: events.deliveredAt,
      dead_at: events.deadAt,
      created_at: events.createdAt
    })
    .from(events)
    .innerJoin(endpoints, eq(endpoints.id, events.endpointId))
    .where(and(...filters))
    .orderBy(desc(events.createdAt))
    .limit(limit)
}

async function findEventDetail(db: DbClient, clientId: string, eventId: string) {
  const [row] = await db
    .select({ event: events, endpoint: endpoints })
    .from(events)
    .innerJoin(endpoints, eq(endpoints.id, events.endpointId))
    .where(and(eq(events.id, eventId), eq(endpoints.clientId, clientId)))
    .limit(1)
  if (!row) return null

  const attempts = await db
    .select()
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.eventId, eventId))
    .orderBy(deliveryAttempts.attemptNumber)

  return {
    id: row.event.id,
    endpoint_id: row.event.endpointId,
    event_type: row.event.eventType,
    payload: row.event.payload,
    status: row.event.status,
    delivered_at: row.event.deliveredAt,
    dead_at: row.event.deadAt,
    created_at: row.event.createdAt,
    attempts: attempts.map((a) => ({
      attempt_number: a.attemptNumber,
      attempted_at: a.attemptedAt,
      status_code: a.statusCode,
      duration_ms: a.durationMs,
      error_class: a.errorClass,
      response_body_excerpt: a.responseBodyExcerpt
    }))
  }
}
