import { randomBytes } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { encryptSecret, decryptSecret } from '../../src/crypto/encryption'

describe('encryption (AES-256-GCM)', () => {
  const masterKey = randomBytes(32)

  it('roundtrip plaintext -> ciphertext -> plaintext', () => {
    const plaintext = 'whsec_super_secret_value_42'
    const ciphertext = encryptSecret(plaintext, masterKey)
    const decrypted = decryptSecret(ciphertext, masterKey)
    expect(decrypted).toBe(plaintext)
  })

  it('produit un ciphertext différent à chaque appel (IV aléatoire)', () => {
    const plaintext = 'same_input'
    const c1 = encryptSecret(plaintext, masterKey)
    const c2 = encryptSecret(plaintext, masterKey)
    expect(Buffer.compare(c1, c2)).not.toBe(0)
  })

  it('decrypt avec une mauvaise master key échoue', () => {
    const plaintext = 'secret'
    const ciphertext = encryptSecret(plaintext, masterKey)
    const wrongKey = randomBytes(32)
    expect(() => decryptSecret(ciphertext, wrongKey)).toThrow()
  })

  it('decrypt avec un ciphertext altéré échoue (auth tag invalide)', () => {
    const ciphertext = encryptSecret('secret', masterKey)
    const lastIdx = ciphertext.length - 1
    const lastByte = ciphertext.readUInt8(lastIdx)
    ciphertext.writeUInt8(lastByte ^ 1, lastIdx)
    expect(() => decryptSecret(ciphertext, masterKey)).toThrow()
  })

  it('rejette une master key qui ne fait pas 32 bytes', () => {
    expect(() => encryptSecret('x', randomBytes(16))).toThrow(/32 bytes/)
  })
})
