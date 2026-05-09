import { Queue, type ConnectionOptions, type WorkerOptions } from 'bullmq'
import { backoffMs, MAX_ATTEMPTS } from '@vitrine/core'

export const QUEUE_NAME = 'webhook-deliveries'

export interface DeliveryJobData {
  eventId: string
}

export function createDeliveryQueue(connection: ConnectionOptions): Queue<DeliveryJobData> {
  return new Queue<DeliveryJobData>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'custom' },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 }
    }
  })
}

export function workerSettings(): WorkerOptions['settings'] {
  return {
    backoffStrategy: (attemptsMade: number) => {
      // BullMQ: attemptsMade is the number of attempts done so far (1-indexed for next).
      // Our schedule: attempt 1 is immediate, retries are attempts 2..7.
      // After attempt N fails, BullMQ asks the delay before attempt N+1.
      const nextAttempt = attemptsMade + 1
      if (nextAttempt > MAX_ATTEMPTS) return -1 // signal no more retries
      return backoffMs(nextAttempt)
    }
  }
}
