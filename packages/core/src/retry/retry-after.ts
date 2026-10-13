// ============================================================================
//  retry-after.ts — Parse the HTTP `Retry-After` header (sent with a 429).
//  Two possible forms: a number of seconds, OR an HTTP date.
//  Returns a delay in ms, or null if invalid / out of bounds.
// ============================================================================
export function parseRetryAfter(
  header: string | null,
  nowMs: number,
  maxMs: number,
): number | null {
  if (header === null) return null

  // Form 1: "Retry-After: 120" (seconds).
  const asNumber = Number(header)
  if (Number.isFinite(asNumber)) {
    const ms = asNumber * 1000
    if (ms < 0 || ms > maxMs) return null // negative or too far → ignore
    return ms
  }

  // Form 2: "Retry-After: Wed, 21 Oct 2026 07:28:00 GMT" (absolute date).
  const dateMs = Date.parse(header)
  if (Number.isNaN(dateMs)) return null // not a valid date
  const delta = dateMs - nowMs // how long until then
  if (delta < 0 || delta > maxMs) return null
  return delta
}
