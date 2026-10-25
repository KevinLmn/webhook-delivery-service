// ============================================================================
//  breaker.ts — The bridge between Node and the breaker's Lua script.
//  Loads the script into Redis ONCE, then calls it by its SHA (EVALSHA).
// ============================================================================
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BreakerState } from '@vitrine/core'
import type { Redis } from 'ioredis'

// Path to the .lua next to this file → its content is read at startup.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SCRIPT = readFileSync(path.join(__dirname, 'lua', 'record_outcome.lua'), 'utf8')

// Default values (match the spec).
const DEFAULT_INITIAL_OPEN_MS = 30_000
const DEFAULT_MAX_OPEN_MS = 30 * 60_000
const DEFAULT_FAIL_THRESHOLD = 5
const TTL_SEC = 24 * 3600

export interface BreakerConfigOverride {
  initialOpenMs?: number
  maxOpenMs?: number
  failThreshold?: number
}

let configOverride: BreakerConfigOverride | null = null

/**
 * TEST-only hook: shorten durations/threshold for fast integration tests.
 * Production code never calls this (the defaults match the spec).
 */
export function setBreakerConfigOverride(override: BreakerConfigOverride | null): void {
  configOverride = override
}

export type BreakerEvent = 'success' | 'failure' | 'read'

// Cache the loaded script's SHA so we don't resend the script on every call.
// Safe to share process-wide: the SHA1 depends only on the script text, so it is
// the same for every Redis client. Only Redis' own script cache can be lost.
let scriptSha: string | null = null

// Loads the script into Redis (SCRIPT LOAD) → returns its SHA1. Only once.
async function loadScript(redis: Redis): Promise<string> {
  if (scriptSha) return scriptSha
  scriptSha = (await redis.script('LOAD', SCRIPT)) as string
  return scriptSha
}

// Calls the atomic breaker and returns the new state.
export async function recordOutcome(
  redis: Redis,
  endpointId: string,
  event: BreakerEvent,
  nowMs: number,
): Promise<BreakerState> {
  let sha = await loadScript(redis)
  // The args order must match ARGV[1..6] in the .lua.
  const args = [
    event,
    String(nowMs),
    String(configOverride?.initialOpenMs ?? DEFAULT_INITIAL_OPEN_MS),
    String(configOverride?.maxOpenMs ?? DEFAULT_MAX_OPEN_MS),
    String(configOverride?.failThreshold ?? DEFAULT_FAIL_THRESHOLD),
    String(TTL_SEC),
  ]
  let raw: string
  try {
    // EVALSHA = "run the already-loaded script by its SHA" (lighter than EVAL).
    // The "1" = number of KEYS; here KEYS[1] = `breaker:${endpointId}`.
    // The key goes through KEYS (not built inside Lua) so Redis Cluster could
    // route the script to the node that owns it.
    raw = (await redis.evalsha(sha, 1, `breaker:${endpointId}`, ...args)) as string
  } catch (err) {
    // If Redis forgot the script (restart, flush) → NOSCRIPT error.
    // Reload it and retry once.
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
