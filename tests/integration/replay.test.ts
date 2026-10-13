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

describe('replay variants (dead/delivered/pending)', () => {
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

  it('replay dead → redelivered', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'replay-dead' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey,
    })

    // 4xx marks the event dead in a single attempt (no retries).
    fake.setResponse({ kind: 'fail', statusCode: 401 })

    const ingest = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': 'replay-dead-1',
      },
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { id: 1 },
      }),
    })
    expect(ingest.status).toBe(202)
    const { id: eventId } = (await ingest.json()) as { id: string }

    await waitFor(async () => {
      const detail = (await fetch(`${app.baseUrl}/events/${eventId}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }).then((r) => r.json())) as EventDetail
      return detail.status === 'dead'
    }, 5_000)

    // Now flip the fake to ok and replay. Replay should re-enqueue and the
    // event should land in delivered state.
    fake.setResponse({ kind: 'ok' })

    const replay = await fetch(`${app.baseUrl}/events/${eventId}/replay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(replay.status).toBe(200)

    await waitFor(async () => {
      const detail = (await fetch(`${app.baseUrl}/events/${eventId}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }).then((r) => r.json())) as EventDetail
      return detail.status === 'delivered'
    }, 5_000)
  })

  it('replay delivered → allowed and redelivered', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'replay-delivered' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey,
    })
    fake.setResponse({ kind: 'ok' })

    const ingest = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': 'replay-delivered-1',
      },
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { id: 2 },
      }),
    })
    expect(ingest.status).toBe(202)
    const { id: eventId } = (await ingest.json()) as { id: string }

    await waitFor(async () => {
      const detail = (await fetch(`${app.baseUrl}/events/${eventId}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }).then((r) => r.json())) as EventDetail
      return detail.status === 'delivered'
    }, 5_000)

    const beforeCount = fake.received().length

    const replay = await fetch(`${app.baseUrl}/events/${eventId}/replay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(replay.status).toBe(200)

    // The replay re-enqueues the event; it should be delivered again, which
    // shows up as an additional fake call and an extra delivery_attempts row.
    await waitFor(async () => fake.received().length > beforeCount, 5_000)

    const detail = (await fetch(`${app.baseUrl}/events/${eventId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }).then((r) => r.json())) as EventDetail
    expect(detail.status).toBe('delivered')
    expect(detail.attempts.length).toBeGreaterThanOrEqual(2)
  })

  it('replay pending → 409', async () => {
    const { clientId, apiKey } = await seedClient(app.db, { name: 'replay-pending' })
    const { endpointId } = await seedEndpoint(app.db, {
      clientId,
      url: fake.url,
      masterKey: app.masterKey,
    })

    // Make the fake hold the request open so the worker stays in-flight while
    // the test issues a replay against the pending event.
    fake.setResponse({ kind: 'timeout', delayMs: 3_000 })

    const ingest = await fetch(`${app.baseUrl}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': 'replay-pending-1',
      },
      body: JSON.stringify({
        endpoint_id: endpointId,
        event_type: 'order.shipped',
        payload: { id: 3 },
      }),
    })
    expect(ingest.status).toBe(202)
    const { id: eventId } = (await ingest.json()) as { id: string }

    // Confirm the worker has begun the request (status still pending).
    await waitFor(async () => fake.received().length >= 1, 5_000)
    const detail = (await fetch(`${app.baseUrl}/events/${eventId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }).then((r) => r.json())) as EventDetail
    expect(detail.status).toBe('pending')

    const replay = await fetch(`${app.baseUrl}/events/${eventId}/replay`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(replay.status).toBe(409)
    const body = (await replay.json()) as { error: string }
    expect(body.error).toBe('event_pending')
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
