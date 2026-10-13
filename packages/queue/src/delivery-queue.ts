// ============================================================================
//  delivery-queue.ts — BullMQ QUEUE configuration (producer side).
//  The API adds jobs here; the worker consumes them.
// ============================================================================
import { Queue, type ConnectionOptions, type WorkerOptions } from 'bullmq'
import { backoffMs, MAX_ATTEMPTS } from '@vitrine/core'

export const QUEUE_NAME = 'webhook-deliveries'

// The data carried by each job: just the ID of the event to deliver.
// (The worker reloads the rest from the DB — the job stays lightweight.)
export interface DeliveryJobData {
  eventId: string
}

// Creates the queue, with each job's default options.
export function createDeliveryQueue(connection: ConnectionOptions): Queue<DeliveryJobData> {
  return new Queue<DeliveryJobData>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: MAX_ATTEMPTS,          // 7 attempts max (see the backoff schedule)
      backoff: { type: 'custom' },     // use OUR delay strategy (below)
      removeOnComplete: { count: 1000 }, // keep the last 1000 completed jobs (the rest is purged)
      removeOnFail: { count: 5000 }    // keep the last 5000 failed jobs
    }
  })
}

// The custom backoff strategy, wired into the worker.
export function workerSettings(): WorkerOptions['settings'] {
  return {
    // BullMQ calls this to know how long to wait before the next attempt.
    backoffStrategy: (attemptsMade: number) => {
      // attemptsMade = number of attempts ALREADY made.
      // Our schedule: attempt 1 = immediate, retries = attempts 2..7.
      // After attempt N fails, BullMQ asks for the delay before N+1.
      const nextAttempt = attemptsMade + 1
      if (nextAttempt > MAX_ATTEMPTS) return -1 // -1 = no more retries (give up)
      return backoffMs(nextAttempt)             // our exponential delay + jitter
    }
  }
}
