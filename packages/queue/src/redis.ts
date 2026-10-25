import { Redis, type RedisOptions } from 'ioredis'

export function createRedisClient(url: string, opts: Partial<RedisOptions> = {}): Redis {
  const client = new Redis(url, {
    // BullMQ requirement: its blocking commands must wait for Redis to come back,
    // not reject after N reconnect attempts (which would crash the worker loop).
    maxRetriesPerRequest: null, // BullMQ requirement
    enableReadyCheck: false,
    ...opts,
  })
  return client
}
