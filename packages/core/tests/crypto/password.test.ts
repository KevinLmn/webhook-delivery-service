import { describe, it, expect } from 'vitest'
import { hashApiKey, verifyApiKey } from '../../src/crypto/password'

describe('password (argon2id)', () => {
  it('hash retourne une string PHC argon2id', async () => {
    const h = await hashApiKey('cl_secret_test_token')
    expect(h.startsWith('$argon2id$')).toBe(true)
  })

  it('verify accepte le bon token', async () => {
    const token = 'cl_secret_correct_horse_battery_staple'
    const h = await hashApiKey(token)
    expect(await verifyApiKey(h, token)).toBe(true)
  })

  it('verify rejette un mauvais token', async () => {
    const h = await hashApiKey('right')
    expect(await verifyApiKey(h, 'wrong')).toBe(false)
  })

  it('hash deux fois le même token produit deux hashes différents', async () => {
    const token = 'same'
    const h1 = await hashApiKey(token)
    const h2 = await hashApiKey(token)
    expect(h1).not.toBe(h2)
  })
})
