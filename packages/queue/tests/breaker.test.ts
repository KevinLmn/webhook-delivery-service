import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { Redis } from 'ioredis'
import { recordOutcome } from '../src/breaker'

describe('record_outcome.lua', () => {
  let container: StartedTestContainer
  let redis: Redis

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start()
    redis = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
      maxRetriesPerRequest: null
    })
  }, 60_000)

  afterAll(async () => {
    await redis?.quit()
    await container?.stop()
  })

  it('démarre en closed avec failCount=0 (read sur clé absente)', async () => {
    const r = await recordOutcome(redis, 'ep_test1', 'read', Date.now())
    expect(r.state).toBe('closed')
    expect(r.failCount).toBe(0)
  })

  it('5 failures consécutifs → open', async () => {
    const ep = 'ep_test2'
    for (let i = 0; i < 4; i++) {
      const r = await recordOutcome(redis, ep, 'failure', Date.now())
      expect(r.state).toBe('closed')
      expect(r.failCount).toBe(i + 1)
    }
    const final = await recordOutcome(redis, ep, 'failure', Date.now())
    expect(final.state).toBe('open')
    expect(final.openDurationMs).toBe(30_000)
  })

  it('open expire → half_open puis success → closed', async () => {
    const ep = 'ep_test3'
    for (let i = 0; i < 5; i++) await recordOutcome(redis, ep, 'failure', 1_000_000)
    // simulate now > openedAt + 30s
    const halfOpen = await recordOutcome(redis, ep, 'read', 1_000_000 + 31_000)
    expect(halfOpen.state).toBe('half_open')
    const closed = await recordOutcome(redis, ep, 'success', 1_000_000 + 32_000)
    expect(closed.state).toBe('closed')
  })

  it('half_open + failure → open avec duration doublée', async () => {
    const ep = 'ep_test4'
    for (let i = 0; i < 5; i++) await recordOutcome(redis, ep, 'failure', 2_000_000)
    await recordOutcome(redis, ep, 'read', 2_000_000 + 31_000) // → half_open
    const open2 = await recordOutcome(redis, ep, 'failure', 2_000_000 + 32_000)
    expect(open2.state).toBe('open')
    expect(open2.openDurationMs).toBe(60_000)
  })
})
