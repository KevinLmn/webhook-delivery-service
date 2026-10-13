import { describe, it, expect } from 'vitest'
import { newId, isId } from '../src/ids'

describe('ids', () => {
  it("generates an id with the right prefix", () => {
    const id = newId('evt')
    expect(id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('isId accepts a valid id', () => {
    const id = newId('cl')
    expect(isId(id, 'cl')).toBe(true)
  })

  it('isId rejects a different prefix', () => {
    const id = newId('cl')
    expect(isId(id, 'ep')).toBe(false)
  })

  it('isId rejects an invalid ULID format', () => {
    expect(isId('cl_short', 'cl')).toBe(false)
    expect(isId('cl_lowercase01HZxxxxxxxxxxxxxxxxxxxx', 'cl')).toBe(false)
  })
})
