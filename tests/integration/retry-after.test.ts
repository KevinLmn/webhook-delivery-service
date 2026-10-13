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

describe('429 Retry-After is respected', () => {
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

  it('second attempt waits ~1s when fake returns 429 with Retry-After: 1', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'retry-after' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey,
    })

    // Initially throttle with Retry-After: 1 (seconds). The schedule override's
    // first retry is 50ms, so the worker must respect the larger Retry-After.
    fake.setResponse({ kind: 'throttle', retryAfter: '1' })
    // Switch to OK after 1.5s — the second attempt (waiting ~1s) should see 200.
    setTimeout(() => fake.setResponse({ kind: 'ok' }), 1_500)

    const res = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': 'retry-after-1',
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
    expect(attempts.find((a) => a.status_code === 429)).toBeDefined()
    expect(attempts.find((a) => a.status_code === 200)).toBeDefined()

    // Verify the second attempt actually waited ~1s and not 50ms (the schedule
    // override's first retry). Two received requests with > 700ms gap proves
    // the worker honoured Retry-After.
    const received = fake.received()
    expect(received.length).toBeGreaterThanOrEqual(2)
    const gapMs = received[1]!.receivedAt - received[0]!.receivedAt
    expect(gapMs).toBeGreaterThanOrEqual(700)
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
