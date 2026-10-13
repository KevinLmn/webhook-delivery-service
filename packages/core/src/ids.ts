// ============================================================================
//  ids.ts — Generation and verification of prefixed IDs (e.g. "evt_01H...").
//  Format = "<prefix>_<ULID>". A ULID is time-sortable (≠ UUID).
// ============================================================================
import { ulid } from 'ulid'

// The 4 possible prefixes: client, endpoint, event, delivery attempt.
export type IdPrefix = 'cl' | 'ep' | 'evt' | 'da'

// A valid ULID: 26 characters from the Crockford base32 alphabet.
const PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

// Creates a new ID, e.g. newId('evt') → "evt_01HXYZ...".
// The return type `${P}_${string}` tells TS it really starts with the prefix.
export function newId<P extends IdPrefix>(prefix: P): `${P}_${string}` {
  return `${prefix}_${ulid()}` as `${P}_${string}`
}

// Checks that an unknown value IS an ID with this prefix (type guard).
// Useful to validate input without trusting it blindly.
export function isId<P extends IdPrefix>(value: unknown, prefix: P): value is `${P}_${string}` {
  if (typeof value !== 'string') return false
  if (!value.startsWith(`${prefix}_`)) return false
  const ulidPart = value.slice(prefix.length + 1) // whatever follows "<prefix>_"
  return PATTERN.test(ulidPart)
}
