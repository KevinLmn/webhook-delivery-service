import { Redis, type RedisOptions } from 'ioredis'

export function createRedisClient(url: string, opts: Partial<RedisOptions> = {}): Redis {
  const client = new Redis(url, {
    maxRetriesPerRequest: null, // BullMQ requirement
    enableReadyCheck: false,
    ...opts
  })
  return client
}
