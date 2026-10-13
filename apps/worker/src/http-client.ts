import { type Outcome, classifyOutcome, signWebhook } from '@vitrine/core'
// ============================================================================
//  http-client.ts — ONE HTTP delivery attempt (one signed POST, once).
//  Decides NOTHING (no retry, no breaker): it delivers and reports the result.
// ============================================================================
import { request } from 'undici' // fast HTTP client for Node

export interface DeliverHttpParams {
  url: string
  body: string
  secret: string
  eventId: string
  timestamp: number
  timeoutMs: number
}

export interface HttpDeliveryResult {
  outcome: Outcome // category (success / 5xx / 4xx / throttle / timeout / network)
  statusCode: number | null // null if no response (network error)
  durationMs: number
  responseBodyExcerpt: string | null
}

const EXCERPT_MAX = 1000 // keep only the first 1000 characters of the response

export async function deliverOnce(p: DeliverHttpParams): Promise<HttpDeliveryResult> {
  // 1) SIGN (HMAC): "v1,<base64>" over "id.timestamp.body".
  const sig = signWebhook({ secret: p.secret, id: p.eventId, timestamp: p.timestamp, body: p.body })
  const start = Date.now()

  try {
    // 2) The POST, with Standard Webhooks headers + timeouts.
    const res = await request(p.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': p.eventId,
        'webhook-timestamp': String(p.timestamp),
        'webhook-signature': sig,
      },
      body: p.body,
      bodyTimeout: p.timeoutMs,
      headersTimeout: p.timeoutMs,
    })
    const text = await res.body.text()
    const excerpt = text.length > EXCERPT_MAX ? text.slice(0, EXCERPT_MAX) : text

    // 3) Read the Retry-After header (may be a string, an array, or absent).
    const retryAfterRaw = res.headers['retry-after']
    const retryAfter =
      typeof retryAfterRaw === 'string'
        ? retryAfterRaw
        : Array.isArray(retryAfterRaw)
          ? retryAfterRaw[0]
          : undefined

    // 4) Classify the response (2xx=success, 429=throttle, 4xx, 5xx...).
    return {
      outcome: classifyOutcome({
        kind: 'response',
        statusCode: res.statusCode,
        ...(retryAfter !== undefined ? { retryAfter } : {}),
      }),
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      responseBodyExcerpt: excerpt.length > 0 ? excerpt : null,
    }
  } catch (err) {
    // 5) No response (timeout, DNS, refused...) → classify the error.
    const code = (err as { code?: string }).code ?? 'UNKNOWN'
    return {
      outcome: classifyOutcome({ kind: 'error', errorCode: code }),
      statusCode: null,
      durationMs: Date.now() - start,
      responseBodyExcerpt: null,
    }
  }
}
