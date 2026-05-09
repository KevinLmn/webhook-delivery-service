import {
  type AppFixture,
  type FakeEndpoint,
  seedClient,
  seedEndpoint,
  startApp,
  startFakeEndpoint
} from '@vitrine/test-helpers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface EventDetail {
  status: string
  attempts: { attempt_number: number; status_code: number | null }[]
}

describe('4xx → direct DLQ (no retries)', () => {
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

  it('401 from endpoint → status=dead in a single attempt', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'four-xx' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey
    })
    fake.setResponse({ kind: 'fail', statusCode: 401 })

    const res = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': 'four-xx-1'
      },
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { id: 1 }
      })
    })
    expect(res.status).toBe(202)
    const { id: eventId } = (await res.json()) as { id: string }

    let detail: EventDetail | null = null
    await waitFor(async () => {
      detail = (await fetch(`${app.baseUrl}/events/${eventId}`, {
        headers: { authorization: `Bearer ${apiKey}` }
      }).then((r) => r.json())) as EventDetail
      return detail.status === 'dead'
    }, 5_000)

    expect(detail).not.toBeNull()
    expect(detail!.status).toBe('dead')
    // 4xx is terminal: exactly one attempt, no retries.
    expect(detail!.attempts.length).toBe(1)
    expect(detail!.attempts[0]!.status_code).toBe(401)

    // Confirm no further HTTP calls happen after the wait window — the worker
    // must not have re-enqueued the job after the 4xx.
    const receivedAfterDead = fake.received().length
    await new Promise((r) => setTimeout(r, 500))
    expect(fake.received().length).toBe(receivedAfterDead)
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
