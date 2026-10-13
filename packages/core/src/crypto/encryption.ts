// ============================================================================
//  encryption.ts — ENCRYPTION of endpoint secrets AT REST (AES-256-GCM).
//  If the DB leaks, secrets stay unreadable without the master key (stored outside the DB).
//  GCM = AUTHENTICATED encryption: detects any tampering with the ciphertext.
// ============================================================================
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_BYTES = 12 // recommended IV (nonce) size for GCM
const TAG_BYTES = 16 // GCM authentication tag size
const KEY_BYTES = 32 // AES-256 = 32-byte key

// Guard: the master key must be exactly 32 bytes.
function assertKey(masterKey: Buffer): void {
  if (masterKey.length !== KEY_BYTES) {
    throw new Error(`master key must be ${KEY_BYTES} bytes, got ${masterKey.length}`)
  }
}

// Encrypts a secret. Returns a Buffer = [ IV (12B) | tag (16B) | ciphertext ].
export function encryptSecret(plaintext: string, masterKey: Buffer): Buffer {
  assertKey(masterKey)
  const iv = randomBytes(IV_BYTES) // ⭐ RANDOM IV every time (never reused)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag() // the tag that guarantees integrity
  // Concatenate everything: decryption will split IV | tag | ciphertext back out.
  return Buffer.concat([iv, tag, enc])
}

// Decrypts. If the ciphertext (or tag) was modified, final() throws.
export function decryptSecret(ciphertext: Buffer, masterKey: Buffer): string {
  assertKey(masterKey)
  if (ciphertext.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext too short')
  // Split the buffer in the same order as at encryption.
  const iv = ciphertext.subarray(0, IV_BYTES)
  const tag = ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const enc = ciphertext.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
  decipher.setAuthTag(tag) // provide the tag → GCM will verify integrity
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
