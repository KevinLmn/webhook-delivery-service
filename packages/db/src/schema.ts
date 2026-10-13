// ============================================================================
//  schema.ts — THE DATA MODEL (4 tables). The system's "vocabulary".
//  Written with Drizzle ORM: each pgTable(...) describes a Postgres table.
// ============================================================================
import { sql } from 'drizzle-orm'
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// "Custom" column type: bytea = raw binary data in Postgres.
// Used to store the ENCRYPTED secret (a Buffer), not text.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType: () => 'bytea',
})

// --- CLIENTS table: the tenants (accounts) using the API ---
export const clients = pgTable('clients', {
  id: text('id').primaryKey(), // ex: "cl_01H..."
  name: text('name').notNull(),
  apiKeyHash: text('api_key_hash').notNull().unique(), // HASH of the API key (never the plaintext key)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// --- ENDPOINTS table: webhook destination URLs ---
export const endpoints = pgTable(
  'endpoints',
  {
    id: text('id').primaryKey(), // ex: "ep_01H..."
    clientId: text('client_id') // which client owns the endpoint
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }), // client deleted → its endpoints too
    url: text('url').notNull(), // the https URL to deliver to
    secretEncrypted: bytea('secret_encrypted').notNull(), // HMAC secret ENCRYPTED at rest (AES-256-GCM)
    description: text('description'),
    archivedAt: timestamp('archived_at', { withTimezone: true }), // NULL = active; set = "soft delete"
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Soft delete via archived_at + partial index WHERE archived_at IS NULL
    // PARTIAL INDEX: indexes ONLY active endpoints → speeds up "client X's
    // endpoints" while staying small (archived ones are not indexed).
    activeIdx: index('endpoints_client_active_idx')
      .on(t.clientId)
      .where(sql`${t.archivedAt} IS NULL`),
  }),
)

// --- EVENTS table: ingested events, to be delivered ---
export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(), // ex: "evt_01H..."
    endpointId: text('endpoint_id') // which endpoint to deliver to
      .notNull()
      .references(() => endpoints.id),
    eventType: text('event_type').notNull(), // ex: "user.created"
    payload: jsonb('payload').notNull(), // the content, as JSONB (indexable JSON)
    status: text('status').notNull(), // 'pending' | 'delivered' | 'dead'
    deliveredAt: timestamp('delivered_at', { withTimezone: true }), // set when delivered
    deadAt: timestamp('dead_at', { withTimezone: true }), // set when given up
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // COMPOSITE INDEX (3 columns): queries "an endpoint's events, filtered by
    // status, sorted by date". Order matters: endpointId (=), status (=), createdAt (sort).
    statusIdx: index('events_endpoint_status_idx').on(t.endpointId, t.status, t.createdAt),
    // CHECK CONSTRAINT: Postgres rejects any status outside these 3 values.
    statusCheck: check('events_status_check', sql`${t.status} IN ('pending','delivered','dead')`),
  }),
)

// --- DELIVERY_ATTEMPTS table: ONE row per delivery attempt (audit trail) ---
export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: text('id').primaryKey(), // ex: "da_01H..."
    eventId: text('event_id') // which event
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(), // 1, 2, 3... (attempt number)
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
    statusCode: integer('status_code'), // HTTP status received (NULL on network error)
    durationMs: integer('duration_ms').notNull(), // attempt duration
    errorClass: text('error_class'), // 'http_5xx' | 'timeout' | ... (NULL on success)
    responseBodyExcerpt: text('response_body_excerpt'), // start of the response (debug)
  },
  (t) => ({
    // UNIQUE INDEX: forbids two identical (event, attempt number) rows
    // → guarantees an attempt is never duplicated.
    uniq: uniqueIndex('delivery_attempts_event_attempt_uniq').on(t.eventId, t.attemptNumber),
  }),
)

// TypeScript types derived automatically from the tables (for the rest of the code).
export type Client = typeof clients.$inferSelect
export type Endpoint = typeof endpoints.$inferSelect
export type Event = typeof events.$inferSelect
export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect
