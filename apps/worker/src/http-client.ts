import { request } from 'undici'
import { classifyOutcome, signWebhook, type Outcome } from '@vitrine/core'

export interface DeliverHttpParams {
  url: string
  body: string
  secret: string
  eventId: string
  timestamp: number
  timeoutMs: number
}

export interface HttpDeliveryResult {
  outcome: Outcome
  statusCode: number | null
  durationMs: number
  responseBodyExcerpt: string | null
}

const EXCERPT_MAX = 1000

export async function deliverOnce(p: DeliverHttpParams): Promise<HttpDeliveryResult> {
  const sig = signWebhook({ secret: p.secret, id: p.eventId, timestamp: p.timestamp, body: p.body })
  const start = Date.now()

  try {
    const res = await request(p.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': p.eventId,
        'webhook-timestamp': String(p.timestamp),
        'webhook-signature': sig
      },
      body: p.body,
      bodyTimeout: p.timeoutMs,
      headersTimeout: p.timeoutMs
    })
    const text = await res.body.text()
    const excerpt = text.length > EXCERPT_MAX ? text.slice(0, EXCERPT_MAX) : text
    const retryAfterRaw = res.headers['retry-after']
    const retryAfter =
      typeof retryAfterRaw === 'string'
        ? retryAfterRaw
        : Array.isArray(retryAfterRaw)
          ? retryAfterRaw[0]
          : undefined
    return {
      outcome: classifyOutcome({
        kind: 'response',
        statusCode: res.statusCode,
        ...(retryAfter !== undefined ? { retryAfter } : {})
      }),
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      responseBodyExcerpt: excerpt.length > 0 ? excerpt : null
    }
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'UNKNOWN'
    return {
      outcome: classifyOutcome({ kind: 'error', errorCode: code }),
      statusCode: null,
      durationMs: Date.now() - start,
      responseBodyExcerpt: null
    }
  }
}
