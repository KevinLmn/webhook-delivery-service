import { createDeliveryQueue, createRedisClient, type DeliveryJobData } from '@vitrine/queue'
import type { Queue } from 'bullmq'
import fp from 'fastify-plugin'
import type { Redis } from 'ioredis'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
    deliveryQueue: Queue<DeliveryJobData>
  }
}

export const queuePlugin = fp<{ redis?: Redis }>(async (app, opts) => {
  const redis = opts.redis ?? createRedisClient(app.config.redisUrl)
  // BullMQ ConnectionOptions accepts an existing IORedis instance directly.
  const queue = createDeliveryQueue(redis)
  app.decorate('redis', redis)
  app.decorate('deliveryQueue', queue)
  app.addHook('onClose', async () => {
    await queue.close()
    await redis.quit()
  })
})
