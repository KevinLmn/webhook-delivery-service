import { hash, verify } from '@node-rs/argon2'

// Algorithm enum from @node-rs/argon2: Argon2d=0, Argon2i=1, Argon2id=2.
// Inlined here because the package exports it as a const enum, which clashes
// with verbatimModuleSyntax. Numeric literal is the documented escape hatch.
const ARGON2ID = 2

const PARAMS = {
  memoryCost: 19456, // ~19 MiB, OWASP recommendation
  timeCost: 2,
  parallelism: 1,
  algorithm: ARGON2ID,
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
