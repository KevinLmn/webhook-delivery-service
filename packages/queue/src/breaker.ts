import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Redis } from 'ioredis'
import type { BreakerState } from '@vitrine/core'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SCRIPT = readFileSync(path.join(__dirname, 'lua', 'record_outcome.lua'), 'utf8')

const INITIAL_OPEN_MS = 30_000
const MAX_OPEN_MS = 30 * 60_000
const FAIL_THRESHOLD = 5
const TTL_SEC = 24 * 3600

export type BreakerEvent = 'success' | 'failure' | 'read'

let scriptSha: string | null = null

async function loadScript(redis: Redis): Promise<string> {
  if (scriptSha) return scriptSha
  scriptSha = (await redis.script('LOAD', SCRIPT)) as string
  return scriptSha
}

export async function recordOutcome(
  redis: Redis,
  endpointId: string,
  event: BreakerEvent,
  nowMs: number
): Promise<BreakerState> {
  let sha = await loadScript(redis)
  const args = [
    event,
    String(nowMs),
    String(INITIAL_OPEN_MS),
    String(MAX_OPEN_MS),
    String(FAIL_THRESHOLD),
    String(TTL_SEC)
  ]
  let raw: string
  try {
    raw = (await redis.evalsha(sha, 1, `breaker:${endpointId}`, ...args)) as string
  } catch (err) {
    if (err instanceof Error && err.message.includes('NOSCRIPT')) {
      scriptSha = null
      sha = await loadScript(redis)
      raw = (await redis.evalsha(sha, 1, `breaker:${endpointId}`, ...args)) as string
    } else {
      throw err
    }
  }
  return JSON.parse(raw) as BreakerState
}
