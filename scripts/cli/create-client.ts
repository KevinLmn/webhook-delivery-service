#!/usr/bin/env tsx
import { createDbClient } from '@vitrine/db'
import { seedClient } from '@vitrine/test-helpers'

const args = process.argv.slice(2)
const nameIdx = args.indexOf('--name')
if (nameIdx === -1 || !args[nameIdx + 1]) {
  console.error('usage: pnpm cli:create-client --name <client-name>')
  process.exit(1)
}
const name = args[nameIdx + 1]!

if (!process.env.DATABASE_URL) {
  console.error('error: DATABASE_URL env var is required')
  console.error(
    'example: DATABASE_URL=postgres://postgres:postgres@localhost:5432/vitrine pnpm cli:create-client --name acme'
  )
  process.exit(1)
}

const db = createDbClient(process.env.DATABASE_URL)
const { clientId, apiKey } = await seedClient(db, { name })

console.log(`client_id  : ${clientId}`)
console.log(`api_key    : ${apiKey}`)
console.log('  ↑ store securely; this is the only time it will be shown.')
process.exit(0)
