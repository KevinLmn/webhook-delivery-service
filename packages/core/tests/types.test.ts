import { describe, it, expect } from 'vitest'
import { CreateEndpointSchema, IngestEventSchema, EventTypeSchema, EndpointIdSchema } from '../src/types'

describe('Zod schemas', () => {
  it('EventTypeSchema accepte order.shipped', () => {
    expect(EventTypeSchema.parse('order.shipped')).toBe('order.shipped')
  })

  it('EventTypeSchema rejette MAJUSCULE', () => {
    expect(() => EventTypeSchema.parse('Order.Shipped')).toThrow()
  })

  it('EventTypeSchema rejette les espaces', () => {
    expect(() => EventTypeSchema.parse('order shipped')).toThrow()
  })

  it('EndpointIdSchema accepte un id valide', () => {
    expect(EndpointIdSchema.parse('ep_01HZA1B2C3D4E5F6G7H8J9K0M1')).toBe('ep_01HZA1B2C3D4E5F6G7H8J9K0M1')
  })

  it('EndpointIdSchema rejette préfixe différent', () => {
    expect(() => EndpointIdSchema.parse('cl_01HZA1B2C3D4E5F6G7H8J9K0M1')).toThrow()
  })

  it('CreateEndpointSchema accepte url HTTPS', () => {
    const result = CreateEndpointSchema.parse({ url: 'https://example.com/hook' })
    expect(result.url).toBe('https://example.com/hook')
  })

  it('CreateEndpointSchema rejette url HTTP plain', () => {
    expect(() => CreateEndpointSchema.parse({ url: 'http://example.com/hook' })).toThrow(/https/)
  })

  it('IngestEventSchema valide un payload complet', () => {
    const valid = {
      endpoint_id: 'ep_01HZA1B2C3D4E5F6G7H8J9K0M1',
      event_type: 'order.shipped',
      payload: { id: 42 }
    }
    expect(IngestEventSchema.parse(valid)).toEqual(valid)
  })
})
