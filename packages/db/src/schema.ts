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

const bytea = customType<{ data: Buffer; default: false }>({
  dataType: () => 'bytea',
})

export const clients = pgTable('clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  apiKeyHash: text('api_key_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const endpoints = pgTable(
  'endpoints',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    secretEncrypted: bytea('secret_encrypted').notNull(),
    description: text('description'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    activeIdx: index('endpoints_client_active_idx')
      .on(t.clientId)
      .where(sql`${t.archivedAt} IS NULL`),
  }),
)

export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => endpoints.id),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deadAt: timestamp('dead_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    statusIdx: index('events_endpoint_status_idx').on(
      t.endpointId,
      t.status,
      t.createdAt,
    ),
    statusCheck: check(
      'events_status_check',
      sql`${t.status} IN ('pending','delivered','dead')`,
    ),
  }),
)

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    statusCode: integer('status_code'),
    durationMs: integer('duration_ms').notNull(),
    errorClass: text('error_class'),
    responseBodyExcerpt: text('response_body_excerpt'),
  },
  (t) => ({
    uniq: uniqueIndex('delivery_attempts_event_attempt_uniq').on(
      t.eventId,
      t.attemptNumber,
    ),
  }),
)

export type Client = typeof clients.$inferSelect
export type Endpoint = typeof endpoints.$inferSelect
export type Event = typeof events.$inferSelect
export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect
