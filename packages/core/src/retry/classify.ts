// ============================================================================
//  classify.ts — CLASSIFY a delivery attempt's result into a category.
//  That category then decides: success? retry? give up?
// ============================================================================

// The possible outcome categories.
export type Outcome =
  | { kind: 'success' } //  2xx/3xx: delivered
  | { kind: 'http_5xx' } //  server error → transient → retry
  | { kind: 'http_4xx' } //  client error (content) → terminal, no retry
  | { kind: 'throttle'; retryAfterRaw: string | null } //  429: too many requests → retry (honors Retry-After)
  | { kind: 'timeout' } //  no response in time → retry
  | { kind: 'network' } //  network failure (DNS, refused...) → retry

// The input: either a received HTTP response, or an error (no response).
export type Input =
  | { kind: 'response'; statusCode: number; retryAfter?: string }
  | { kind: 'error'; errorCode: string }

// undici/Node error codes that map to a timeout.
const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT'])

export function classifyOutcome(input: Input): Outcome {
  if (input.kind === 'response') {
    const s = input.statusCode
    if (s >= 200 && s < 400) return { kind: 'success' } // 2xx/3xx = OK
    if (s === 429) return { kind: 'throttle', retryAfterRaw: input.retryAfter ?? null } // rate limited
    if (s >= 400 && s < 500) return { kind: 'http_4xx' } // content-side fault → terminal
    return { kind: 'http_5xx' } // 5xx → server failure → retry
  }
  // No response at all: timeout or other network error.
  if (TIMEOUT_CODES.has(input.errorCode)) return { kind: 'timeout' }
  return { kind: 'network' }
}
