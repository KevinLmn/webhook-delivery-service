// ============================================================================
//  events.ts — Event routes: POST /events (ingestion) + GET (list/detail).
// ============================================================================
import { IngestEventSchema } from '@vitrine/core'
import { events, type DbClient, deliveryAttempts, endpoints } from '@vitrine/db'
import { type SQL, and, desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsync } from 'fastify'
import { ingestEvent } from '../services/ingestion'

interface EventsListQuery {
  status?: string
  endpoint_id?: string
  limit?: string
}

export const eventsRoutes: FastifyPluginAsync = async (app) => {
  // --- POST /events: ingest an event ---
  app.post('/events', async (request, reply) => {
    // 1) Auth: authPlugin set request.clientId if the Bearer token is valid.
    if (!request.clientId) return reply.code(401).send({ error: 'unauthorized' })

    // 2) Idempotency-Key is REQUIRED (otherwise deduplication is impossible).
    const idemKey = request.headers['idempotency-key']
    if (typeof idemKey !== 'string' || idemKey.length === 0) {
      return reply.code(400).send({ error: 'idempotency_key_required' })
    }

    // 3) Validate the body with Zod (endpoint_id, event_type, payload ≤ 1 MB).
    const parsed = IngestEventSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues })
    }

    // 4) The actual logic is delegated to the ingestEvent service.
    const result = await ingestEvent({
      db: app.db,
      redis: app.redis,
      queue: app.deliveryQueue,
      clientId: request.clientId,
      endpointId: parsed.data.endpoint_id,
      eventType: parsed.data.event_type,
      payload: parsed.data.payload,
      idempotencyKey: idemKey,
    })

    // 5) Map the result to an HTTP status code (see your note "HTTP - Status Codes").
    if (result.kind === 'endpoint_not_found') {
      return reply.code(404).send({ error: 'endpoint_not_found' })
    }
    if (result.kind === 'conflict') {
      return reply.code(422).send({ error: 'idempotency_conflict' }) // same key, different payload
    }
    // created → 202 (accepted, ASYNC delivery); existing (replay) → 200
    const status = result.kind === 'created' ? 202 : 200
    return reply.code(status).send({
      id: result.eventId,
      status: 'pending',
      endpoint_id: parsed.data.endpoint_id,
    })
  })

  // --- GET /events: list the client's events (status/endpoint filters) ---
  app.get<{ Querystring: EventsListQuery }>('/events', async (request, reply) => {
    if (!request.clientId) return reply.code(401).send({ error: 'unauthorized' })
    const rows = await listEventsForClient(app.db, request.clientId, request.query)
    return rows
  })

  // --- GET /events/:id: an event's details + all its attempts ---
  app.get<{ Params: { id: string } }>('/events/:id', async (request, reply) => {
    if (!request.clientId) return reply.code(401).send({ error: 'unauthorized' })
    const detail = await findEventDetail(app.db, request.clientId, request.params.id)
    if (!detail) return reply.code(404).send({ error: 'not_found' })
    return detail
  })
}

// Listing query: events↔endpoints join, filtered by clientId (multi-tenant
// isolation: you ONLY see your own events), sorted by date, limited.
async function listEventsForClient(db: DbClient, clientId: string, query: EventsListQuery) {
  const filters: SQL[] = [eq(endpoints.clientId, clientId)] // ⭐ scoped by clientId
  if (query.status === 'pending' || query.status === 'delivered' || query.status === 'dead') {
    filters.push(eq(events.status, query.status))
  }
  if (query.endpoint_id) {
    filters.push(eq(events.endpointId, query.endpoint_id))
  }
  const limit = Math.min(Number(query.limit ?? 50), 200) // hard cap at 200

  return db
    .select({
      id: events.id,
      endpoint_id: events.endpointId,
      event_type: events.eventType,
      status: events.status,
      delivered_at: events.deliveredAt,
      dead_at: events.deadAt,
      created_at: events.createdAt,
    })
    .from(events)
    .innerJoin(endpoints, eq(endpoints.id, events.endpointId))
    .where(and(...filters))
    .orderBy(desc(events.createdAt))
    .limit(limit)
}

// Event detail: we check it REALLY belongs to this client (anti-IDOR),
// then fetch all its delivery_attempts (the audit trail).
// Shaped consistently with the listing: columns are aliased INSIDE the .select
// (no more manual mapping in JS). Only the final { ...event, attempts } assembly
// stays in JS, since it combines two queries (nesting is unavoidable).
async function findEventDetail(db: DbClient, clientId: string, eventId: string) {
  const [event] = await db
    .select({
      id: events.id,
      endpoint_id: events.endpointId,
      event_type: events.eventType,
      payload: events.payload,
      status: events.status,
      delivered_at: events.deliveredAt,
      dead_at: events.deadAt,
      created_at: events.createdAt,
    })
    .from(events)
    .innerJoin(endpoints, eq(endpoints.id, events.endpointId))
    .where(and(eq(events.id, eventId), eq(endpoints.clientId, clientId))) // ⭐ event AND client
    .limit(1)
  if (!event) return null

  const attempts = await db
    .select({
      attempt_number: deliveryAttempts.attemptNumber,
      attempted_at: deliveryAttempts.attemptedAt,
      status_code: deliveryAttempts.statusCode,
      duration_ms: deliveryAttempts.durationMs,
      error_class: deliveryAttempts.errorClass,
      response_body_excerpt: deliveryAttempts.responseBodyExcerpt,
    })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.eventId, eventId))
    .orderBy(deliveryAttempts.attemptNumber)

  return { ...event, attempts }
}
