import { describe, it, expect } from 'vitest'
import { classifyOutcome, type Outcome } from '../../src/retry/classify'

describe('classifyOutcome', () => {
  it('200 → success', () => {
    expect(classifyOutcome({ kind: 'response', statusCode: 200 })).toEqual<Outcome>({ kind: 'success' })
  })

  it('299 → success', () => {
    expect(classifyOutcome({ kind: 'response', statusCode: 299 })).toEqual<Outcome>({ kind: 'success' })
  })

  it('301 → success (treat 3xx as delivered)', () => {
    expect(classifyOutcome({ kind: 'response', statusCode: 301 })).toEqual<Outcome>({ kind: 'success' })
  })

  it('500 → http_5xx', () => {
    expect(classifyOutcome({ kind: 'response', statusCode: 500 })).toEqual<Outcome>({ kind: 'http_5xx' })
  })

  it('400 → http_4xx (no retry)', () => {
    expect(classifyOutcome({ kind: 'response', statusCode: 400 })).toEqual<Outcome>({ kind: 'http_4xx' })
  })

  it('404 → http_4xx', () => {
    expect(classifyOutcome({ kind: 'response', statusCode: 404 })).toEqual<Outcome>({ kind: 'http_4xx' })
  })

  it('429 → throttle', () => {
    expect(classifyOutcome({ kind: 'response', statusCode: 429, retryAfter: '30' }))
      .toEqual<Outcome>({ kind: 'throttle', retryAfterRaw: '30' })
  })

  it('429 without Retry-After → throttle with retryAfterRaw null', () => {
    expect(classifyOutcome({ kind: 'response', statusCode: 429 }))
      .toEqual<Outcome>({ kind: 'throttle', retryAfterRaw: null })
  })

  it('error.timeout → timeout', () => {
    expect(classifyOutcome({ kind: 'error', errorCode: 'UND_ERR_HEADERS_TIMEOUT' }))
      .toEqual<Outcome>({ kind: 'timeout' })
  })

  it('error.network → network', () => {
    expect(classifyOutcome({ kind: 'error', errorCode: 'ECONNRESET' }))
      .toEqual<Outcome>({ kind: 'network' })
  })
})
