export function parseRetryAfter(header: string | null, nowMs: number, maxMs: number): number | null {
  if (header === null) return null

  const asNumber = Number(header)
  if (Number.isFinite(asNumber)) {
    const ms = asNumber * 1000
    if (ms < 0 || ms > maxMs) return null
    return ms
  }

  const dateMs = Date.parse(header)
  if (Number.isNaN(dateMs)) return null
  const delta = dateMs - nowMs
  if (delta < 0 || delta > maxMs) return null
  return delta
}
