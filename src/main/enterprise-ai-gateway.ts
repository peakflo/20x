import { safeStorage } from 'electron'

import type { DatabaseManager } from './database'

export const ENTERPRISE_AI_GATEWAY_PROVIDER_ID = 'peakflo'
export const ENTERPRISE_AI_GATEWAY_PROVIDER_NAME = 'Peakflo'

// DB setting keys kept as 'enterprise_litellm_*' for migration safety
export const ENTERPRISE_AI_GATEWAY_KEYS = {
  API_KEY: 'enterprise_litellm_api_key',
  BASE_URL: 'enterprise_litellm_base_url',
  KEY_NAME: 'enterprise_litellm_key_name',
  EXPIRES_AT: 'enterprise_litellm_expires_at',
  MODELS: 'enterprise_litellm_models'
} as const

export interface EnterpriseAiGatewayModel {
  id: string
  name: string
}

export interface StoredEnterpriseAiGatewayConfig {
  apiKey: string
  baseUrl: string
  keyName?: string | null
  expiresAt?: string | null
  models?: EnterpriseAiGatewayModel[]
}

function encryptValue(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64')
  }
  return Buffer.from(value, 'utf8').toString('base64')
}

function decryptValue(stored: string): string {
  const buf = Buffer.from(stored, 'base64')
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(buf)
  }
  return buf.toString('utf8')
}

export function readEnterpriseAiGatewayConfig(
  db: Pick<DatabaseManager, 'getSetting'>
): StoredEnterpriseAiGatewayConfig | null {
  const encryptedApiKey = db.getSetting(ENTERPRISE_AI_GATEWAY_KEYS.API_KEY)
  const encryptedBaseUrl = db.getSetting(ENTERPRISE_AI_GATEWAY_KEYS.BASE_URL)

  if (!encryptedApiKey || !encryptedBaseUrl) {
    return null
  }

  try {
    const keyName = db.getSetting(ENTERPRISE_AI_GATEWAY_KEYS.KEY_NAME)
    const expiresAt = db.getSetting(ENTERPRISE_AI_GATEWAY_KEYS.EXPIRES_AT)
    const modelsRaw = db.getSetting(ENTERPRISE_AI_GATEWAY_KEYS.MODELS)
    return {
      apiKey: decryptValue(encryptedApiKey),
      baseUrl: decryptValue(encryptedBaseUrl),
      keyName: keyName || null,
      expiresAt: expiresAt || null,
      models: modelsRaw ? JSON.parse(modelsRaw) as EnterpriseAiGatewayModel[] : []
    }
  } catch {
    return null
  }
}

export function storeEnterpriseAiGatewayConfig(
  db: Pick<DatabaseManager, 'setSetting'>,
  config: StoredEnterpriseAiGatewayConfig
): void {
  db.setSetting(ENTERPRISE_AI_GATEWAY_KEYS.API_KEY, encryptValue(config.apiKey))
  db.setSetting(ENTERPRISE_AI_GATEWAY_KEYS.BASE_URL, encryptValue(config.baseUrl))
  db.setSetting(ENTERPRISE_AI_GATEWAY_KEYS.KEY_NAME, config.keyName ?? '')
  db.setSetting(ENTERPRISE_AI_GATEWAY_KEYS.EXPIRES_AT, config.expiresAt ?? '')
  db.setSetting(
    ENTERPRISE_AI_GATEWAY_KEYS.MODELS,
    JSON.stringify(config.models ?? [])
  )
}

export function clearEnterpriseAiGatewayConfig(
  db: Pick<DatabaseManager, 'deleteSetting'>
): void {
  for (const key of Object.values(ENTERPRISE_AI_GATEWAY_KEYS)) {
    db.deleteSetting(key)
  }
}

export function buildEnterpriseAiGatewayProviderConfig(
  stored: StoredEnterpriseAiGatewayConfig
): Record<string, unknown> {
  const models = (stored.models ?? []).reduce<Record<string, { name: string }>>(
    (acc, model) => {
      acc[model.id] = { name: model.name }
      return acc
    },
    {}
  )

  return {
    [ENTERPRISE_AI_GATEWAY_PROVIDER_ID]: {
      npm: '@ai-sdk/openai-compatible',
      name: ENTERPRISE_AI_GATEWAY_PROVIDER_NAME,
      options: {
        baseURL: stored.baseUrl,
        apiKey: stored.apiKey
      },
      models
    }
  }
}
