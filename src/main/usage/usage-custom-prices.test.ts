import { describe, it, expect, beforeEach } from 'vitest'
import { listCustomModelPrices, setCustomModelPrice, resetCustomModelPrice, type SettingsAccess } from './usage-custom-prices'

function fakeSettings(): SettingsAccess {
  const store = new Map<string, string>()
  return {
    getSetting: (key) => store.get(key),
    setSetting: (key, value) => store.set(key, value)
  }
}

let db: SettingsAccess

beforeEach(() => {
  db = fakeSettings()
})

describe('custom model prices', () => {
  it('starts empty', () => {
    expect(listCustomModelPrices(db)).toEqual([])
  })

  it('creates a price and normalises the model id (lowercase, no provider prefix)', () => {
    const result = setCustomModelPrice(db, { model: 'My-Custom-Model', inputPerMTok: 3, outputPerMTok: 15 })
    expect(result).toEqual([{ model: 'my-custom-model', inputPerMTok: 3, outputPerMTok: 15 }])
  })

  it('upserts: setting the same model again replaces it rather than duplicating', () => {
    setCustomModelPrice(db, { model: 'm', inputPerMTok: 1, outputPerMTok: 2 })
    const result = setCustomModelPrice(db, { model: 'm', inputPerMTok: 5, outputPerMTok: 10 })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ inputPerMTok: 5, outputPerMTok: 10 })
  })

  it('keeps optional cache rates only when provided, including an explicit 0 (free)', () => {
    setCustomModelPrice(db, { model: 'a', inputPerMTok: 1, outputPerMTok: 2 })
    setCustomModelPrice(db, { model: 'b', inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0, cacheWritePerMTok: 0.5 })
    const prices = listCustomModelPrices(db)
    expect(prices.find((p) => p.model === 'a')).not.toHaveProperty('cacheReadPerMTok')
    expect(prices.find((p) => p.model === 'b')).toMatchObject({ cacheReadPerMTok: 0, cacheWritePerMTok: 0.5 })
  })

  it('rejects a price with no model id or a non-finite rate', () => {
    expect(() => setCustomModelPrice(db, { model: '', inputPerMTok: 1, outputPerMTok: 2 })).toThrow()
    expect(() => setCustomModelPrice(db, { model: 'm', inputPerMTok: NaN, outputPerMTok: 2 })).toThrow()
  })

  it('resets (removes) a price by model id', () => {
    setCustomModelPrice(db, { model: 'm', inputPerMTok: 1, outputPerMTok: 2 })
    expect(listCustomModelPrices(db)).toHaveLength(1)
    const result = resetCustomModelPrice(db, 'm')
    expect(result).toEqual([])
  })

  it('resetting an unknown model is a no-op', () => {
    setCustomModelPrice(db, { model: 'm', inputPerMTok: 1, outputPerMTok: 2 })
    expect(resetCustomModelPrice(db, 'unknown')).toHaveLength(1)
  })

  it('lists prices sorted by model id', () => {
    setCustomModelPrice(db, { model: 'zeta', inputPerMTok: 1, outputPerMTok: 2 })
    setCustomModelPrice(db, { model: 'alpha', inputPerMTok: 1, outputPerMTok: 2 })
    expect(listCustomModelPrices(db).map((p) => p.model)).toEqual(['alpha', 'zeta'])
  })

  it('ignores a corrupt settings value instead of throwing', () => {
    db.setSetting('usage:customModelPrices', '{not json')
    expect(listCustomModelPrices(db)).toEqual([])
  })
})
