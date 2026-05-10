import { describe, expect, it } from 'vitest'

import { getNodejsAssetName, selectGhMacAsset } from './install.js'

describe('getNodejsAssetName', () => {
  it('uses the universal macOS pkg name without an arch suffix', () => {
    expect(getNodejsAssetName('darwin', 'arm64', 'v22.20.0')).toBe('node-v22.20.0.pkg')
    expect(getNodejsAssetName('darwin', 'x64', 'v22.20.0')).toBe('node-v22.20.0.pkg')
  })

  it('retains platform-specific naming for Windows and Linux', () => {
    expect(getNodejsAssetName('win32', 'arm64', 'v22.20.0')).toBe('node-v22.20.0-arm64.msi')
    expect(getNodejsAssetName('linux', 'x64', 'v22.20.0')).toBe('node-v22.20.0-linux-x64.tar.xz')
  })
})

describe('selectGhMacAsset', () => {
  it('prefers the macOS zip asset when present', () => {
    const asset = selectGhMacAsset({
      assets: [
        { name: 'gh_2.92.0_macOS_arm64.pkg', browser_download_url: 'https://example.com/gh.pkg' },
        { name: 'gh_2.92.0_macOS_arm64.zip', browser_download_url: 'https://example.com/gh.zip' }
      ]
    }, 'arm64')

    expect(asset?.name).toBe('gh_2.92.0_macOS_arm64.zip')
    expect(asset?.browser_download_url).toBe('https://example.com/gh.zip')
  })

  it('falls back to the macOS pkg asset when zip is unavailable', () => {
    const asset = selectGhMacAsset({
      assets: [
        { name: 'gh_2.92.0_macOS_amd64.pkg', browser_download_url: 'https://example.com/gh.pkg' }
      ]
    }, 'x64')

    expect(asset?.name).toBe('gh_2.92.0_macOS_amd64.pkg')
  })

  it('returns null when no compatible macOS asset exists', () => {
    const asset = selectGhMacAsset({
      assets: [
        { name: 'gh_2.92.0_linux_arm64.tar.gz', browser_download_url: 'https://example.com/gh.tgz' }
      ]
    }, 'arm64')

    expect(asset).toBeNull()
  })
})
