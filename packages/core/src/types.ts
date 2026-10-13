// ============================================================================
//  types.ts — Typed IDs + API input VALIDATION (via Zod).
//  Zod = a lib that validates data shape at runtime AND gives you the TS type.
// ============================================================================
import { z } from 'zod'

// A ULID = 26 characters from this alphabet (Crockford base32, no I/L/O/U).
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

// ID schemas: a prefix (cl_/ep_/evt_) FOLLOWED by a valid ULID.
// .refine(...) adds a custom rule (here: the part after the prefix is a ULID).
export const ClientIdSchema = z.string().regex(/^cl_/).refine((v) => ULID_RE.test(v.slice(3)))
export const EndpointIdSchema = z.string().regex(/^ep_/).refine((v) => ULID_RE.test(v.slice(3)))
export const EventIdSchema = z.string().regex(/^evt_/).refine((v) => ULID_RE.test(v.slice(4)))
// event_type: lowercase words separated by dots, e.g. "user.created".
export const EventTypeSchema = z.string().regex(/^[a-z]+(\.[a-z]+)*$/)

// z.infer<...> = "give me the TypeScript type matching this Zod schema".
export type ClientId = z.infer<typeof ClientIdSchema>
export type EndpointId = z.infer<typeof EndpointIdSchema>
export type EventId = z.infer<typeof EventIdSchema>

// POST /endpoints body validation: a URL, https only.
export const CreateEndpointSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'must be https'), // no plaintext http
  description: z.string().max(500).optional()
})

export type CreateEndpointInput = z.infer<typeof CreateEndpointSchema>

// POST /events body validation.
export const IngestEventSchema = z.object({
  endpoint_id: EndpointIdSchema,
  event_type: EventTypeSchema,
  // payload: anything (unknown), BUT rejected above 1 MB
  // (we measure the serialized JSON size in UTF-8 bytes).
  payload: z.unknown().refine(
    (v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= 1_048_576,
    'payload exceeds 1 MB'
  )
})

export type IngestEventInput = z.infer<typeof IngestEventSchema>

// The only 3 possible statuses of an event.
export const EventStatusSchema = z.enum(['pending', 'delivered', 'dead'])
export type EventStatus = z.infer<typeof EventStatusSchema>
