import { hash, verify, Algorithm } from '@node-rs/argon2'

const PARAMS = {
  memoryCost: 19456, // ~19 MiB, OWASP recommendation
  timeCost: 2,
  parallelism: 1,
  algorithm: Algorithm.Argon2id,
}

export function hashApiKey(token: string): Promise<string> {
  return hash(token, PARAMS)
}

export async function verifyApiKey(storedHash: string, token: string): Promise<boolean> {
  try {
    return await verify(storedHash, token)
  } catch {
    return false
  }
}
