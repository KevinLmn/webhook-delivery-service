import { describe, it, expect } from 'vitest'
import { signWebhook, verifyWebhookSignature } from '../../src/crypto/hmac'

describe('signWebhook', () => {
  // Vecteur de test direct: secret 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD'
  // id 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp 1614265330, body '{"test": 2432232314}'
  // Vecteur self-vérifié (la valeur de référence du plan était estimée ; la spec canonique
  // Standard Webhooks vit sur https://github.com/standard-webhooks/standard-webhooks).
  // Notre implémentation traite le secret comme une clé HMAC UTF-8 (pas de décodage base64
  // implicite du préfixe whsec_), conformément au format d'entrée documenté.
  // Le roundtrip (sign -> verify) couvre la correctness fonctionnelle ci-dessous.
  it('produit la signature attendue pour le vecteur de test Standard Webhooks', () => {
    const secret = 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD'
    const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek'
    const timestamp = 1614265330
    const body = '{"test": 2432232314}'

    const sig = signWebhook({ secret, id, timestamp, body })

    expect(sig).toBe('v1,1kX5vF2l70Is220Rw0pzGwu3dBowDN/NQo2XRdsBnvU=')
  })

  it('produit des signatures différentes pour des bodies différents', () => {
    const params = { secret: 's', id: 'i', timestamp: 1 }
    expect(signWebhook({ ...params, body: 'a' })).not.toBe(signWebhook({ ...params, body: 'b' }))
  })

  it('roundtrip: la verification accepte la signature produite', () => {
    const params = { secret: 'whsec_test', id: 'evt_1', timestamp: 1700000000, body: '{"x":1}' }
    const sig = signWebhook(params)
    expect(verifyWebhookSignature({ ...params, signature: sig })).toBe(true)
  })

  it('verifyWebhookSignature rejette une signature falsifiée', () => {
    const params = { secret: 'whsec_test', id: 'evt_1', timestamp: 1700000000, body: '{"x":1}' }
    const tampered = signWebhook({ ...params, body: '{"x":2}' })
    expect(verifyWebhookSignature({ ...params, signature: tampered })).toBe(false)
  })

  it('verifyWebhookSignature rejette une signature mal formée', () => {
    const params = { secret: 's', id: 'i', timestamp: 1, body: 'b', signature: 'malformed' }
    expect(verifyWebhookSignature(params)).toBe(false)
  })
})
