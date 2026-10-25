import { events, type DbClient, endpoints } from '@vitrine/db'
import type { DeliveryJobData } from '@vitrine/queue'
import type { Queue } from 'bullmq'
import { and, eq } from 'drizzle-orm'

export type ReplayResult =
  | { kind: 'enqueued' }
  | { kind: 'not_found' }
  | { kind: 'conflict_pending' }

export async function replayEvent(opts: {
  db: DbClient
  queue: Queue<DeliveryJobData>
  clientId: string
  eventId: string
}): Promise<ReplayResult> {
  // Check ownership: the event belongs to one of the client's endpoints.
  const [row] = await opts.db
    .select({ event: events, endpoint: endpoints })
    .from(events)
    .innerJoin(endpoints, eq(endpoints.id, events.endpointId))
    .where(and(eq(events.id, opts.eventId), eq(endpoints.clientId, opts.clientId)))
    .limit(1)

  if (!row) return { kind: 'not_found' }
  // Refuse while pending: two live jobs for one event would race on attemptNumber
  // and could deliver twice. (Check-then-update, not atomic: two replays sent at
  // the same instant could both pass.)
  if (row.event.status === 'pending') return { kind: 'conflict_pending' }

  await opts.db
    .update(events)
    .set({ status: 'pending', deliveredAt: null, deadAt: null })
    .where(eq(events.id, opts.eventId))

  await opts.queue.add(
    'deliver',
    { eventId: opts.eventId },
    // NOT jobId = eventId: the original job may still be kept in Redis
    // (removeOnComplete/removeOnFail), and add() with an existing jobId is
    // silently ignored, so the replay would never run.
    { jobId: `${opts.eventId}-replay-${Date.now()}` },
  )

  return { kind: 'enqueued' }
}
