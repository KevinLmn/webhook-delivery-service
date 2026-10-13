import {
  type AppFixture,
  type FakeEndpoint,
  seedClient,
  seedEndpoint,
  startApp,
  startFakeEndpoint,
} from '@vitrine/test-helpers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('archived endpoint', () => {
  let app: AppFixture
  let fake: FakeEndpoint

  beforeAll(async () => {
    fake = await startFakeEndpoint()
    app = await startApp({
      databaseUrl: process.env.DATABASE_URL!,
      redisUrl: process.env.REDIS_URL!,
    })
  })

  afterAll(async () => {
    await app.close()
    await fake.close()
  })

  it('POST event to archived endpoint → 404', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'archived-ep' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey,
    })

    // Archive (soft-delete) the endpoint via the public DELETE route.
    const del = await fetch(`${app.baseUrl}/endpoints/${endpointId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(del.status).toBe(204)

    // Subsequent ingestion against the archived endpoint should 404.
    const r = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': 'archived-1',
      },
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { id: 1 },
      }),
    })
    expect(r.status).toBe(404)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('endpoint_not_found')
  })
})
