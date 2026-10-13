import {
  type AppFixture,
  type FakeEndpoint,
  seedClient,
  seedEndpoint,
  startApp,
  startFakeEndpoint,
} from '@vitrine/test-helpers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('happy path', () => {
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

  it('delivers an event on the first attempt', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'happy-path' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey,
    })
    fake.setResponse({ kind: 'ok', statusCode: 200 })

    const res = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': 'happy-1',
      },
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { id: 1 },
      }),
    })
    expect(res.status).toBe(202)
    const { id: eventId } = (await res.json()) as { id: string }

    await waitFor(async () => {
      const detail = (await fetch(`${app.baseUrl}/events/${eventId}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }).then((r) => r.json())) as { status: string }
      return detail.status === 'delivered'
    }, 10_000)

    expect(fake.received().length).toBe(1)
    const headers = fake.received()[0]!.headers
    expect(headers['webhook-id']).toBe(eventId)
    expect(headers['webhook-signature']).toMatch(/^v1,/)
  })
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('waitFor timeout')
}
