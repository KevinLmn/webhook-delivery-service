import { describe, expect, it } from 'vitest'
import { hashApiKey, verifyApiKey } from '../../src/crypto/password'

describe('password (argon2id)', () => {
  it('hash returns an argon2id PHC string', async () => {
    const h = await hashApiKey('cl_secret_test_token')
    expect(h.startsWith('$argon2id$')).toBe(true)
  })

  it('verify accepts the right token', async () => {
    const token = 'cl_secret_correct_horse_battery_staple'
    const h = await hashApiKey(token)
    expect(await verifyApiKey(h, token)).toBe(true)
  })

  it('verify rejects a wrong token', async () => {
    const h = await hashApiKey('right')
    expect(await verifyApiKey(h, 'wrong')).toBe(false)
  })

  it('hashing the same token twice yields two different hashes', async () => {
    const token = 'same'
    const h1 = await hashApiKey(token)
    const h2 = await hashApiKey(token)
    expect(h1).not.toBe(h2)
  })
})
