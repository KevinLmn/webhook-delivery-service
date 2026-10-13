import {
  type AppFixture,
  type FakeEndpoint,
  seedClient,
  seedEndpoint,
  startApp,
  startFakeEndpoint
} from '@vitrine/test-helpers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('breaker opens after 5 consecutive failures', () => {
  let app: AppFixture
  let fake: FakeEndpoint

  beforeAll(async () => {
    fake = await startFakeEndpoint()
    app = await startApp({
      databaseUrl: process.env.DATABASE_URL!,
      redisUrl: process.env.REDIS_URL!
    })
  })

  afterAll(async () => {
    await app.close()
    await fake.close()
  })

  it('5th consecutive failure opens the breaker; the 6th event triggers no HTTP call', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'breaker' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey
    })
    fake.setResponse({ kind: 'fail', statusCode: 503 })

    // Push 5 events. Each first attempt fires (delay=0) → 5 5xx outcomes →
    // breaker opens.
    for (let i = 0; i < 5; i++) {
      await fetch(`${app.baseUrl}/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'idempotency-key': `breaker-${i}`
        },
        body: JSON.stringify({
          endpoint_id: endpointId,
          event_type: 'order.shipped',
          payload: { i }
        })
      })
    }

    // Wait until the breaker state is `open` (i.e. the 5 outcomes have been
    // recorded in Redis). Just waiting for fake.received().length>=5 isn't
    // enough — `recordOutcome('failure')` runs *after* the HTTP response is
    // sent, so the test could otherwise push the 6th event before the breaker
    // has actually flipped.
    await waitFor(async () => {
      const raw = await app.redis.get(`breaker:${endpointId}`)
      if (!raw) return false
      return (JSON.parse(raw) as { state: string }).state === 'open'
    }, 5_000)
    const before = fake.received().length
    expect(before).toBeGreaterThanOrEqual(5)

    // 6th event — should be deferred by the breaker (state=open) without
    // hitting the fake endpoint.
    await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': 'breaker-6'
      },
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { i: 6 }
      })
    })

    // The breaker_skip path floors the requeue delay at 1000ms in deliver.ts.
    // Sleeping 500ms keeps us comfortably below that floor so the 6th HTTP
    // call cannot have happened yet.
    await new Promise((r) => setTimeout(r, 500))
    expect(fake.received().length).toBe(before)
  })
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('waitFor timeout')
}
