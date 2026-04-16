import { describe, expect, it } from 'vitest'

const { getMissingNotarizeEnv, shouldNotarize, getNotarizeOptions } = require('./notarize-config')

function createContext(platform: string) {
  return {
    electronPlatformName: platform,
    appOutDir: '/tmp/out',
    packager: {
      appInfo: {
        id: 'com.20x.app',
        productFilename: '20x'
      }
    }
  }
}

describe('notarize-config', () => {
  it('detects missing notarization environment variables', () => {
    expect(getMissingNotarizeEnv({})).toEqual([
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID'
    ])
  })

  it('enables notarization when all required env vars are present on darwin', () => {
    const result = shouldNotarize(createContext('darwin'), {
      APPLE_ID: 'dev@company.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'xxxx-xxxx-xxxx-xxxx',
      APPLE_TEAM_ID: 'ABCD123456'
    })
    expect(result).toEqual({ enabled: true, reason: 'enabled' })
  })

  it('skips notarization when SKIP_NOTARIZE is true', () => {
    const result = shouldNotarize(createContext('darwin'), {
      SKIP_NOTARIZE: 'true',
      APPLE_ID: 'dev@company.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'xxxx-xxxx-xxxx-xxxx',
      APPLE_TEAM_ID: 'ABCD123456'
    })
    expect(result).toEqual({ enabled: false, reason: 'SKIP_NOTARIZE=true' })
  })

  it('skips notarization on non-mac platforms', () => {
    const result = shouldNotarize(createContext('win32'), {
      APPLE_ID: 'dev@company.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'xxxx-xxxx-xxxx-xxxx',
      APPLE_TEAM_ID: 'ABCD123456'
    })
    expect(result).toEqual({ enabled: false, reason: 'not darwin build' })
  })

  it('builds notarize options from context + env', () => {
    const options = getNotarizeOptions(createContext('darwin'), {
      APPLE_ID: 'dev@company.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'xxxx-xxxx-xxxx-xxxx',
      APPLE_TEAM_ID: 'ABCD123456'
    })

    expect(options).toEqual({
      tool: 'notarytool',
      appBundleId: 'com.20x.app',
      appPath: '/tmp/out/20x.app',
      appleId: 'dev@company.com',
      appleIdPassword: 'xxxx-xxxx-xxxx-xxxx',
      teamId: 'ABCD123456'
    })
  })
})
