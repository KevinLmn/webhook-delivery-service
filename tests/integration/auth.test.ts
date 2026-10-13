import {
  type AppFixture,
  type FakeEndpoint,
  seedClient,
  seedEndpoint,
  startApp,
  startFakeEndpoint,
} from '@vitrine/test-helpers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('auth', () => {
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

  it('missing bearer → 401', async () => {
    const { clientId } = await seedClient(app.db, { name: 'auth-missing' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey,
    })

    const r = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'auth-1' },
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { id: 1 },
      }),
    })
    expect(r.status).toBe(401)
  })

  it('invalid bearer → 401', async () => {
    const { clientId } = await seedClient(app.db, { name: 'auth-invalid' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey,
    })

    const r = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer cl_secret_totally_random_invalid_token',
        'idempotency-key': 'auth-2',
      },
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { id: 1 },
      }),
    })
    expect(r.status).toBe(401)
  })
})
