import { describe, it, expect } from 'vitest'
import { newId, isId } from '../src/ids'

describe('ids', () => {
  it("génère un id avec le bon préfixe", () => {
    const id = newId('evt')
    expect(id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('isId accepte un id valide', () => {
    const id = newId('cl')
    expect(isId(id, 'cl')).toBe(true)
  })

  it('isId rejette un préfixe différent', () => {
    const id = newId('cl')
    expect(isId(id, 'ep')).toBe(false)
  })

  it('isId rejette un format ULID invalide', () => {
    expect(isId('cl_short', 'cl')).toBe(false)
    expect(isId('cl_lowercase01HZxxxxxxxxxxxxxxxxxxxx', 'cl')).toBe(false)
  })
})
