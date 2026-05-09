import { ulid } from 'ulid'

export type IdPrefix = 'cl' | 'ep' | 'evt' | 'da'

const PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function newId<P extends IdPrefix>(prefix: P): `${P}_${string}` {
  return `${prefix}_${ulid()}` as `${P}_${string}`
}

export function isId<P extends IdPrefix>(value: unknown, prefix: P): value is `${P}_${string}` {
  if (typeof value !== 'string') return false
  if (!value.startsWith(`${prefix}_`)) return false
  const ulidPart = value.slice(prefix.length + 1)
  return PATTERN.test(ulidPart)
}
