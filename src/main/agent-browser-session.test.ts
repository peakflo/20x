import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const browserSession = {
    cookies: { get: vi.fn(), flushStore: vi.fn() },
    closeAllConnections: vi.fn(), clearStorageData: vi.fn(), clearCache: vi.fn(), clearAuthCache: vi.fn()
  }
  return { browserSession, getAllWebContents: vi.fn() }
})
vi.mock('./agent-browser-session', () => ({ getAgentBrowserSession: () => mocks.browserSession }))
vi.mock('electron', () => ({ webContents: { getAllWebContents: mocks.getAllWebContents } }))

import { clearImportedBrowserSessions } from './browser-session-import'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.browserSession.cookies.get.mockResolvedValue([{ name: 'rotated', domain: '.example.com', path: '/' }])
  mocks.browserSession.cookies.flushStore.mockResolvedValue(undefined)
  mocks.browserSession.clearStorageData.mockResolvedValue(undefined)
  mocks.browserSession.closeAllConnections.mockResolvedValue(undefined)
  mocks.browserSession.clearCache.mockResolvedValue(undefined)
  mocks.browserSession.clearAuthCache.mockResolvedValue(undefined)
})

describe('clear agent browser sessions', () => {
  it('closes active agent pages and clears all partition storage, including rotated cookies', async () => {
    const agentPage = { session: mocks.browserSession, isDestroyed: () => false, loadURL: vi.fn().mockResolvedValue(undefined) }
    const appPage = { session: {}, isDestroyed: () => false, loadURL: vi.fn() }
    mocks.getAllWebContents.mockReturnValue([agentPage, appPage])
    expect(await clearImportedBrowserSessions()).toBe(1)
    expect(agentPage.loadURL).toHaveBeenCalledWith('about:blank')
    expect(appPage.loadURL).not.toHaveBeenCalled()
    expect(mocks.browserSession.clearStorageData).toHaveBeenCalledOnce()
    expect(mocks.browserSession.closeAllConnections).toHaveBeenCalledOnce()
    expect(mocks.browserSession.clearCache).toHaveBeenCalledOnce()
    expect(mocks.browserSession.clearAuthCache).toHaveBeenCalledOnce()
  })

  it('still clears storage when an agent page rejects navigation', async () => {
    mocks.getAllWebContents.mockReturnValue([{ session: mocks.browserSession, isDestroyed: () => false, loadURL: vi.fn().mockRejectedValue(new Error('closed')) }])
    await clearImportedBrowserSessions()
    expect(mocks.browserSession.clearStorageData).toHaveBeenCalledOnce()
  })
})
