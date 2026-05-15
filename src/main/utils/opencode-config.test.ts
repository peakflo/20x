import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildMergedOpencodeConfig, readOpencodeConfig, readOpencodeAuth } from './opencode-config'

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn()
}))

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/testuser')
}))

import { existsSync, readFileSync } from 'fs'

const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('readOpencodeConfig', () => {
  it('returns parsed config when file exists', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      provider: { routerai: { npm: '@ai-sdk/openai-compatible' } }
    }))
    const config = readOpencodeConfig()
    expect(config).toEqual({ provider: { routerai: { npm: '@ai-sdk/openai-compatible' } } })
  })

  it('returns empty object when file does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    expect(readOpencodeConfig()).toEqual({})
  })

  it('returns empty object on parse error', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('not json')
    expect(readOpencodeConfig()).toEqual({})
  })
})

describe('readOpencodeAuth', () => {
  it('returns parsed auth when file exists', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      routerai: { type: 'api', key: 'sk-test' }
    }))
    const auth = readOpencodeAuth()
    expect(auth).toEqual({ routerai: { type: 'api', key: 'sk-test' } })
  })

  it('returns empty object when file does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    expect(readOpencodeAuth()).toEqual({})
  })
})

describe('buildMergedOpencodeConfig', () => {
  it('injects auth.json API key into provider missing apiKey in options', () => {
    // First call: existsSync for config path, second: for auth path
    mockExistsSync.mockReturnValue(true)
    // First readFileSync: opencode.json, second: auth.json
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        provider: {
          routerai: {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'https://routerai.ru/api/v1' },
            models: { 'anthropic/claude-sonnet-4.6': { name: 'Claude Sonnet 4.6' } }
          }
        }
      }))
      .mockReturnValueOnce(JSON.stringify({
        routerai: { type: 'api', key: 'sk-routerai-key' }
      }))

    const config = buildMergedOpencodeConfig()
    const routerai = (config.provider as Record<string, Record<string, unknown>>).routerai
    expect((routerai.options as Record<string, unknown>).apiKey).toBe('sk-routerai-key')
    expect((routerai.options as Record<string, unknown>).baseURL).toBe('https://routerai.ru/api/v1')
  })

  it('does NOT overwrite existing apiKey in provider options', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        provider: {
          featherless: {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'https://api.featherless.ai/v1', apiKey: 'existing-key' }
          }
        }
      }))
      .mockReturnValueOnce(JSON.stringify({
        featherless: { type: 'api', key: 'auth-json-key' }
      }))

    const config = buildMergedOpencodeConfig()
    const featherless = (config.provider as Record<string, Record<string, unknown>>).featherless
    // Should keep the existing key, not overwrite with auth.json
    expect((featherless.options as Record<string, unknown>).apiKey).toBe('existing-key')
  })

  it('merges extraConfig on top', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({ model: 'anthropic/claude-3' }))
      .mockReturnValueOnce(JSON.stringify({}))

    const config = buildMergedOpencodeConfig({ plugin: ['/path/to/plugin.js'] })
    expect(config.model).toBe('anthropic/claude-3')
    expect(config.plugin).toEqual(['/path/to/plugin.js'])
  })

  it('handles missing config and auth files gracefully', () => {
    mockExistsSync.mockReturnValue(false)
    const config = buildMergedOpencodeConfig({ plugin: ['/path/to/plugin.js'] })
    expect(config).toEqual({ plugin: ['/path/to/plugin.js'] })
  })

  it('handles provider with no options object', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        provider: {
          routerai: { npm: '@ai-sdk/openai-compatible' }
        }
      }))
      .mockReturnValueOnce(JSON.stringify({
        routerai: { type: 'api', key: 'sk-key' }
      }))

    const config = buildMergedOpencodeConfig()
    const routerai = (config.provider as Record<string, Record<string, unknown>>).routerai
    expect((routerai.options as Record<string, unknown>).apiKey).toBe('sk-key')
  })
})
