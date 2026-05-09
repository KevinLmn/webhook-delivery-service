import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

function assertKey(masterKey: Buffer): void {
  if (masterKey.length !== KEY_BYTES) {
    throw new Error(`master key must be ${KEY_BYTES} bytes, got ${masterKey.length}`)
  }
}

export function encryptSecret(plaintext: string, masterKey: Buffer): Buffer {
  assertKey(masterKey)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc])
}

export function decryptSecret(ciphertext: Buffer, masterKey: Buffer): string {
  assertKey(masterKey)
  if (ciphertext.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext too short')
  const iv = ciphertext.subarray(0, IV_BYTES)
  const tag = ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const enc = ciphertext.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
