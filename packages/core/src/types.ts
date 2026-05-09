import { z } from 'zod'

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

export const ClientIdSchema = z.string().regex(/^cl_/).refine((v) => ULID_RE.test(v.slice(3)))
export const EndpointIdSchema = z.string().regex(/^ep_/).refine((v) => ULID_RE.test(v.slice(3)))
export const EventIdSchema = z.string().regex(/^evt_/).refine((v) => ULID_RE.test(v.slice(4)))
export const EventTypeSchema = z.string().regex(/^[a-z]+(\.[a-z]+)*$/)

export type ClientId = z.infer<typeof ClientIdSchema>
export type EndpointId = z.infer<typeof EndpointIdSchema>
export type EventId = z.infer<typeof EventIdSchema>

export const CreateEndpointSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'must be https'),
  description: z.string().max(500).optional()
})

export type CreateEndpointInput = z.infer<typeof CreateEndpointSchema>

export const IngestEventSchema = z.object({
  endpoint_id: EndpointIdSchema,
  event_type: EventTypeSchema,
  payload: z.unknown().refine(
    (v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= 1_048_576,
    'payload exceeds 1 MB'
  )
})

export type IngestEventInput = z.infer<typeof IngestEventSchema>

export const EventStatusSchema = z.enum(['pending', 'delivered', 'dead'])
export type EventStatus = z.infer<typeof EventStatusSchema>
