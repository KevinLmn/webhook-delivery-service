import { describe, expect, it } from 'vitest'
import {
  CreateEndpointSchema,
  EndpointIdSchema,
  EventTypeSchema,
  IngestEventSchema,
} from '../src/types'

describe('Zod schemas', () => {
  it('EventTypeSchema accepts order.shipped', () => {
    expect(EventTypeSchema.parse('order.shipped')).toBe('order.shipped')
  })

  it('EventTypeSchema rejects UPPERCASE', () => {
    expect(() => EventTypeSchema.parse('Order.Shipped')).toThrow()
  })

  it('EventTypeSchema rejects spaces', () => {
    expect(() => EventTypeSchema.parse('order shipped')).toThrow()
  })

  it('EndpointIdSchema accepts a valid id', () => {
    expect(EndpointIdSchema.parse('ep_01HZA1B2C3D4E5F6G7H8J9K0M1')).toBe(
      'ep_01HZA1B2C3D4E5F6G7H8J9K0M1',
    )
  })

  it('EndpointIdSchema rejects a different prefix', () => {
    expect(() => EndpointIdSchema.parse('cl_01HZA1B2C3D4E5F6G7H8J9K0M1')).toThrow()
  })

  it('CreateEndpointSchema accepts an HTTPS url', () => {
    const result = CreateEndpointSchema.parse({ url: 'https://example.com/hook' })
    expect(result.url).toBe('https://example.com/hook')
  })

  it('CreateEndpointSchema rejects a plain HTTP url', () => {
    expect(() => CreateEndpointSchema.parse({ url: 'http://example.com/hook' })).toThrow(/https/)
  })

  it('IngestEventSchema validates a complete payload', () => {
    const valid = {
      endpoint_id: 'ep_01HZA1B2C3D4E5F6G7H8J9K0M1',
      event_type: 'order.shipped',
      payload: { id: 42 },
    }
    expect(IngestEventSchema.parse(valid)).toEqual(valid)
  })
})
