import {
  type AppFixture,
  type FakeEndpoint,
  seedClient,
  seedEndpoint,
  startApp,
  startFakeEndpoint
} from '@vitrine/test-helpers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('idempotency', () => {
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

  it('hit: same key + same payload → 200 with existing event_id', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'idem-hit' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey
    })
    const body = JSON.stringify({
      endpoint_id: endpointId,
      event_type: 'order.shipped',
      payload: { id: 1 }
    })
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'idempotency-key': 'idem-hit-1'
    }

    const r1 = await fetch(`${app.baseUrl}/events`, { method: 'POST', headers, body })
    expect(r1.status).toBe(202)
    const { id: id1 } = (await r1.json()) as { id: string }

    const r2 = await fetch(`${app.baseUrl}/events`, { method: 'POST', headers, body })
    expect(r2.status).toBe(200)
    const { id: id2 } = (await r2.json()) as { id: string }

    expect(id2).toBe(id1)

    // Single event row in DB (verified via the list API filtered by endpoint).
    const list = (await fetch(
      `${app.baseUrl}/events?endpoint_id=${endpointId}`,
      { headers: { authorization: `Bearer ${apiKey}` } }
    ).then((r) => r.json())) as Array<{ id: string }>
    expect(list.length).toBe(1)
    expect(list[0]!.id).toBe(id1)
  })

  it('conflict: same key + different payload → 422', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'idem-conflict' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey
    })
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'idempotency-key': 'idem-conflict-1'
    }

    const r1 = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { id: 1 }
      })
    })
    expect(r1.status).toBe(202)

    const r2 = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { id: 2 }
      })
    })
    expect(r2.status).toBe(422)
  })

  it('missing key → 400', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'idem-missing' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey
    })
    const r = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { id: 1 }
      })
    })
    expect(r.status).toBe(400)
  })
})
