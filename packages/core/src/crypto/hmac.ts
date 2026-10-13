// ============================================================================
//  hmac.ts — Webhook SIGNING (Standard Webhooks format).
//  Goal: the client can PROVE the event really comes from us (authenticity
//  + integrity), and reject forgeries. We sign with HMAC-SHA256(secret).
// ============================================================================
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SignParams {
  secret: string // the secret shared with this client/endpoint
  id: string // the event ID (= webhook-id header)
  timestamp: number // unix timestamp (= webhook-timestamp header)
  body: string // the exact JSON body sent
}

export interface VerifyParams extends SignParams {
  signature: string // the received signature, to verify
}

const SUPPORTED_SCHEME = 'v1' // signature format versioning

// Computes the MAC: we sign the string "id.timestamp.body".
// Including timestamp + id protects against REPLAY attacks.
function compute(params: SignParams): string {
  const signedString = `${params.id}.${params.timestamp}.${params.body}`
  const mac = createHmac('sha256', params.secret).update(signedString, 'utf8').digest('base64')
  return mac
}

// Produces the webhook-signature header value, e.g. "v1,<base64>".
export function signWebhook(params: SignParams): string {
  return `${SUPPORTED_SCHEME},${compute(params)}`
}

// Verifies a received signature (receiver side / in tests).
export function verifyWebhookSignature(params: VerifyParams): boolean {
  const [scheme, ...rest] = params.signature.split(',')
  if (scheme !== SUPPORTED_SCHEME || rest.length !== 1) return false // unexpected format
  const provided = rest[0] ?? ''

  let providedBuf: Buffer
  let expectedBuf: Buffer
  try {
    providedBuf = Buffer.from(provided, 'base64') // what the client sent
    expectedBuf = Buffer.from(compute(params), 'base64') // what we recompute
  } catch {
    return false
  }
  if (providedBuf.length !== expectedBuf.length) return false
  // ⭐ timingSafeEqual = CONSTANT-TIME comparison.
  // NEVER compare signatures with ===: it would leak info through
  // response time (timing attack, guessing byte by byte).
  return timingSafeEqual(providedBuf, expectedBuf)
}
