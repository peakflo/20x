/**
 * CRUD for user-set model prices, persisted as one JSON blob in the app's
 * generic key/value `settings` table. Kept decoupled from `DatabaseManager`
 * (only `getSetting`/`setSetting` are needed) so it can be unit tested
 * against a plain in-memory stub.
 */

import type { CustomModelPrice } from '../../shared/usage'
import { normalizeModelId } from './usage-pricing'

const SETTINGS_KEY = 'usage:customModelPrices'

export interface SettingsAccess {
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sanitizePrice(raw: unknown): CustomModelPrice | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const model = typeof value.model === 'string' ? normalizeModelId(value.model).bare : ''
  if (!model || !isFiniteNumber(value.inputPerMTok) || !isFiniteNumber(value.outputPerMTok)) return null
  const price: CustomModelPrice = {
    model,
    inputPerMTok: Math.max(0, value.inputPerMTok),
    outputPerMTok: Math.max(0, value.outputPerMTok)
  }
  if (isFiniteNumber(value.cacheReadPerMTok)) price.cacheReadPerMTok = Math.max(0, value.cacheReadPerMTok)
  if (isFiniteNumber(value.cacheWritePerMTok)) price.cacheWritePerMTok = Math.max(0, value.cacheWritePerMTok)
  return price
}

function readAll(db: SettingsAccess): CustomModelPrice[] {
  const raw = db.getSetting(SETTINGS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(sanitizePrice).filter((price): price is CustomModelPrice => price !== null)
  } catch {
    return []
  }
}

function writeAll(db: SettingsAccess, prices: CustomModelPrice[]): void {
  db.setSetting(SETTINGS_KEY, JSON.stringify(prices))
}

/** All custom prices, sorted by model id. */
export function listCustomModelPrices(db: SettingsAccess): CustomModelPrice[] {
  return readAll(db).sort((a, b) => a.model.localeCompare(b.model))
}

/** Creates or replaces the price for `price.model` (matched after the same normalisation the rate table uses). */
export function setCustomModelPrice(db: SettingsAccess, price: CustomModelPrice): CustomModelPrice[] {
  const sanitized = sanitizePrice(price)
  if (!sanitized) throw new Error('Invalid model price: model id and input/output rates are required.')
  const existing = readAll(db).filter((p) => p.model !== sanitized.model)
  const next = [...existing, sanitized]
  writeAll(db, next)
  return listCustomModelPrices(db)
}

/** Removes the custom price for `model`, if any. The model then prices from the public rate table again. */
export function resetCustomModelPrice(db: SettingsAccess, model: string): CustomModelPrice[] {
  const key = normalizeModelId(model).bare
  const next = readAll(db).filter((p) => p.model !== key)
  writeAll(db, next)
  return listCustomModelPrices(db)
}
