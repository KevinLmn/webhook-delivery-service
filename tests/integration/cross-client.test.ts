import {
  type AppFixture,
  type FakeEndpoint,
  seedClient,
  seedEndpoint,
  startApp,
  startFakeEndpoint
} from '@vitrine/test-helpers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('cross-client isolation', () => {
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

  it("client A using client B's endpoint_id → 404", async () => {
    const { apiKey: aKey } = await seedClient(app.db, { name: 'cross-client-a' })
    const { clientId: bId } = await seedClient(app.db, { name: 'cross-client-b' })
    const { endpointId: bEndpointId } = await seedEndpoint(app.db, {
      clientId: bId,
      url: fake.url,
      masterKey: app.masterKey
    })

    const r = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${aKey}`,
        'idempotency-key': 'cross-1'
      },
      body: JSON.stringify({
        endpoint_id: bEndpointId,
        event_type: 'order.shipped',
        payload: { id: 1 }
      })
    })
    expect(r.status).toBe(404)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('endpoint_not_found')
  })
})
