import {
  type AppFixture,
  type FakeEndpoint,
  seedClient,
  seedEndpoint,
  startApp,
  startFakeEndpoint,
} from '@vitrine/test-helpers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface EventDetail {
  status: string
  attempts: { attempt_number: number; status_code: number | null }[]
}

describe('dlq after exhausting retries', () => {
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

  it('ends in status=dead after 7 attempts', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'dlq' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey,
    })

    // Schedule (overridden in setup): [0, 50, 100, 200, 400, 800, 1600] ms
    // = 3150ms total for the 7 attempts.
    fake.setResponse({ kind: 'fail', statusCode: 500 })

    const res = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': 'dlq-1',
      },
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { id: 1 },
      }),
    })
    expect(res.status).toBe(202)
    const { id: eventId } = (await res.json()) as { id: string }

    let detail: EventDetail | null = null
    await waitFor(async () => {
      detail = (await fetch(`${app.baseUrl}/events/${eventId}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }).then((r) => r.json())) as EventDetail
      return detail.status === 'dead' && detail.attempts.length === 7
    }, 10_000)

    expect(detail).not.toBeNull()
    expect(detail!.status).toBe('dead')
    expect(detail!.attempts.length).toBe(7)
    for (const a of detail!.attempts) {
      expect(a.status_code).toBe(500)
    }
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
