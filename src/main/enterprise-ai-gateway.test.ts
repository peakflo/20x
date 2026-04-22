import { describe, expect, it } from 'vitest'

import {
  buildEnterpriseAiGatewayProviderConfig,
  ENTERPRISE_AI_GATEWAY_PROVIDER_ID,
  readEnterpriseAiGatewayConfig,
  storeEnterpriseAiGatewayConfig
} from './enterprise-ai-gateway'

class MockDb {
  private settings = new Map<string, string>()

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null
  }

  setSetting(key: string, value: string): void {
    this.settings.set(key, value)
  }

  deleteSetting(key: string): void {
    this.settings.delete(key)
  }
}

describe('enterprise AI gateway helpers', () => {
  it('stores and reads AI gateway credentials from the database', () => {
    const db = new MockDb()

    storeEnterpriseAiGatewayConfig(db as never, {
      apiKey: 'sk-virtual-123',
      baseUrl: 'https://litellm.example.com',
      keyName: 'peakflo-key',
      expiresAt: '2026-05-01T00:00:00.000Z'
    })

    expect(readEnterpriseAiGatewayConfig(db as never)).toEqual({
      apiKey: 'sk-virtual-123',
      baseUrl: 'https://litellm.example.com',
      keyName: 'peakflo-key',
      expiresAt: '2026-05-01T00:00:00.000Z',
      models: []
    })
  })

  it('builds an OpenCode custom provider config for Peakflo', () => {
    const providerConfig = buildEnterpriseAiGatewayProviderConfig({
      apiKey: 'sk-virtual-123',
      baseUrl: 'https://litellm.example.com',
      models: [
        { id: 'gpt-4.1-mini', name: 'GPT 4.1 Mini' },
        { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' }
      ]
    })

    expect(providerConfig).toEqual({
      [ENTERPRISE_AI_GATEWAY_PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Peakflo',
        options: {
          baseURL: 'https://litellm.example.com',
          apiKey: 'sk-virtual-123'
        },
        models: {
          'gpt-4.1-mini': {
            name: 'GPT 4.1 Mini'
          },
          'claude-3-7-sonnet': {
            name: 'Claude 3.7 Sonnet'
          }
        }
      }
    })
  })
})
