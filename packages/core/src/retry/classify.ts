export type Outcome =
  | { kind: 'success' }
  | { kind: 'http_5xx' }
  | { kind: 'http_4xx' }
  | { kind: 'throttle'; retryAfterRaw: string | null }
  | { kind: 'timeout' }
  | { kind: 'network' }

export type Input =
  | { kind: 'response'; statusCode: number; retryAfter?: string }
  | { kind: 'error'; errorCode: string }

const TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT'])

export function classifyOutcome(input: Input): Outcome {
  if (input.kind === 'response') {
    const s = input.statusCode
    if (s >= 200 && s < 400) return { kind: 'success' }
    if (s === 429) return { kind: 'throttle', retryAfterRaw: input.retryAfter ?? null }
    if (s >= 400 && s < 500) return { kind: 'http_4xx' }
    return { kind: 'http_5xx' }
  }
  if (TIMEOUT_CODES.has(input.errorCode)) return { kind: 'timeout' }
  return { kind: 'network' }
}
