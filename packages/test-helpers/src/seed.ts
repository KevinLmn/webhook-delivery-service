import { randomBytes } from 'node:crypto'
import { encryptSecret, hashApiKey, newId } from '@vitrine/core'
import { type DbClient, clients, endpoints } from '@vitrine/db'

export async function seedClient(
  db: DbClient,
  opts: { name: string },
): Promise<{ clientId: string; apiKey: string }> {
  const apiKey = `cl_secret_${randomBytes(24).toString('base64url')}`
  const apiKeyHash = await hashApiKey(apiKey)
  const clientId = newId('cl')
  await db.insert(clients).values({ id: clientId, name: opts.name, apiKeyHash })
  return { clientId, apiKey }
}

export async function seedEndpoint(
  db: DbClient,
  opts: { clientId: string; url: string; masterKey: Buffer },
): Promise<{ endpointId: string; secret: string }> {
  const secret = `whsec_${randomBytes(24).toString('base64url')}`
  const secretEncrypted = encryptSecret(secret, opts.masterKey)
  const endpointId = newId('ep')
  await db
    .insert(endpoints)
    .values({ id: endpointId, clientId: opts.clientId, url: opts.url, secretEncrypted })
  return { endpointId, secret }
}
