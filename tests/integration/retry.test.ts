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

describe('retry succeeds after transient 5xx', () => {
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

  it('delivers after a few 5xx failures then success', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'retry' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey,
    })

    // Schedule (overridden in setup): [0, 50, 100, 200, 400, 800, 1600] ms.
    // The 1st attempt fires immediately; the 4th attempt's delay sums to
    // 0 + 50 + 100 + 200 = 350ms after the job is enqueued. Switching the
    // fake to ok at ~250ms ensures the 4th attempt observes 200.
    fake.setResponse({ kind: 'fail', statusCode: 500 })
    setTimeout(() => fake.setResponse({ kind: 'ok' }), 250)

    const res = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': 'retry-1',
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
      return detail.status === 'delivered'
    }, 5_000)

    expect(detail).not.toBeNull()
    const attempts = detail!.attempts
    expect(attempts.length).toBeGreaterThanOrEqual(2)
    expect(attempts.find((a) => a.status_code === 200)).toBeDefined()
    expect(attempts.find((a) => a.status_code === 500)).toBeDefined()
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
