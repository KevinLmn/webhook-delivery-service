import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SignParams {
  secret: string
  id: string
  timestamp: number
  body: string
}

export interface VerifyParams extends SignParams {
  signature: string
}

const SUPPORTED_SCHEME = 'v1'

function compute(params: SignParams): string {
  const signedString = `${params.id}.${params.timestamp}.${params.body}`
  const mac = createHmac('sha256', params.secret).update(signedString, 'utf8').digest('base64')
  return mac
}

export function signWebhook(params: SignParams): string {
  return `${SUPPORTED_SCHEME},${compute(params)}`
}

export function verifyWebhookSignature(params: VerifyParams): boolean {
  const [scheme, ...rest] = params.signature.split(',')
  if (scheme !== SUPPORTED_SCHEME || rest.length !== 1) return false
  const provided = rest[0] ?? ''

  let providedBuf: Buffer
  let expectedBuf: Buffer
  try {
    providedBuf = Buffer.from(provided, 'base64')
    expectedBuf = Buffer.from(compute(params), 'base64')
  } catch {
    return false
  }
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}
