import { randomBytes } from 'node:crypto'
import { encryptSecret, newId } from '@vitrine/core'
import { type DbClient, type Endpoint, endpoints } from '@vitrine/db'
import { and, eq, isNull } from 'drizzle-orm'

export interface CreateEndpointParams {
  db: DbClient
  clientId: string
  url: string
  description?: string
  masterKey: Buffer
}

export interface CreatedEndpoint {
  id: string
  url: string
  secret: string // plaintext, only at creation
  description: string | null
  createdAt: Date
}

export async function createEndpoint(p: CreateEndpointParams): Promise<CreatedEndpoint> {
  const secret = `whsec_${randomBytes(24).toString('base64url')}`
  const secretEncrypted = encryptSecret(secret, p.masterKey)
  const id = newId('ep')
  const [row] = await p.db
    .insert(endpoints)
    .values({
      id,
      clientId: p.clientId,
      url: p.url,
      secretEncrypted,
      description: p.description ?? null,
    })
    .returning()
  if (!row) throw new Error('insert failed')
  return {
    id: row.id,
    url: row.url,
    secret,
    description: row.description,
    createdAt: row.createdAt,
  }
}

export async function listEndpoints(db: DbClient, clientId: string): Promise<Endpoint[]> {
  return db
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.clientId, clientId), isNull(endpoints.archivedAt)))
}

export async function archiveEndpoint(
  db: DbClient,
  clientId: string,
  endpointId: string,
): Promise<boolean> {
  const result = await db
    .update(endpoints)
    .set({ archivedAt: new Date() })
    .where(
      and(
        eq(endpoints.id, endpointId),
        eq(endpoints.clientId, clientId),
        isNull(endpoints.archivedAt),
      ),
    )
    .returning({ id: endpoints.id })
  return result.length > 0
}

export async function findEndpointForClient(
  db: DbClient,
  clientId: string,
  endpointId: string,
): Promise<Endpoint | null> {
  const [row] = await db
    .select()
    .from(endpoints)
    .where(
      and(
        eq(endpoints.id, endpointId),
        eq(endpoints.clientId, clientId),
        isNull(endpoints.archivedAt),
      ),
    )
    .limit(1)
  return row ?? null
}
