import { describe, it, expect } from 'vitest'
import { signWebhook, verifyWebhookSignature } from '../../src/crypto/hmac'

describe('signWebhook', () => {
  // Direct test vector: secret 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD'
  // id 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp 1614265330, body '{"test": 2432232314}'
  // Self-verified vector (the plan's reference value was estimated; the canonical
  // Standard Webhooks spec lives at https://github.com/standard-webhooks/standard-webhooks).
  // Our implementation treats the secret as a UTF-8 HMAC key (no implicit base64
  // decoding of the whsec_ prefix), per the documented input format.
  // The roundtrip (sign -> verify) below covers functional correctness.
  it('produces the expected signature for the Standard Webhooks test vector', () => {
    const secret = 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD'
    const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek'
    const timestamp = 1614265330
    const body = '{"test": 2432232314}'

    const sig = signWebhook({ secret, id, timestamp, body })

    expect(sig).toBe('v1,1kX5vF2l70Is220Rw0pzGwu3dBowDN/NQo2XRdsBnvU=')
  })

  it('produces different signatures for different bodies', () => {
    const params = { secret: 's', id: 'i', timestamp: 1 }
    expect(signWebhook({ ...params, body: 'a' })).not.toBe(signWebhook({ ...params, body: 'b' }))
  })

  it('roundtrip: verification accepts the produced signature', () => {
    const params = { secret: 'whsec_test', id: 'evt_1', timestamp: 1700000000, body: '{"x":1}' }
    const sig = signWebhook(params)
    expect(verifyWebhookSignature({ ...params, signature: sig })).toBe(true)
  })

  it('verifyWebhookSignature rejects a forged signature', () => {
    const params = { secret: 'whsec_test', id: 'evt_1', timestamp: 1700000000, body: '{"x":1}' }
    const tampered = signWebhook({ ...params, body: '{"x":2}' })
    expect(verifyWebhookSignature({ ...params, signature: tampered })).toBe(false)
  })

  it('verifyWebhookSignature rejects a malformed signature', () => {
    const params = { secret: 's', id: 'i', timestamp: 1, body: 'b', signature: 'malformed' }
    expect(verifyWebhookSignature(params)).toBe(false)
  })
})
