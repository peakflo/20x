import { describe, it, expect, vi, beforeEach } from 'vitest'
import { usePluginMarketplaceStore } from './plugin-marketplace-store'

// Mock the IPC client
vi.mock('@/lib/ipc-client', () => ({
  claudePluginApi: {
    getMarketplaceSources: vi.fn().mockResolvedValue([]),
    addMarketplaceSource: vi.fn().mockResolvedValue({ id: 'mp-1', name: 'test-mp', source_type: 'github', source_url: 'owner/repo', metadata: {}, auto_update: false, created_at: '', updated_at: '' }),
    removeMarketplaceSource: vi.fn().mockResolvedValue(true),
    fetchCatalog: vi.fn().mockResolvedValue(null),
    discoverPlugins: vi.fn().mockResolvedValue([]),
    getInstalledPlugins: vi.fn().mockResolvedValue([]),
    installPlugin: vi.fn().mockResolvedValue({ id: 'p-1', name: 'test-plugin', marketplace_id: 'mp-1', manifest: {}, source: {}, scope: 'user', enabled: true, version: '1.0.0', installed_at: '', updated_at: '' }),
    uninstallPlugin: vi.fn().mockResolvedValue(true),
    enablePlugin: vi.fn().mockResolvedValue({ id: 'p-1', enabled: true }),
    disablePlugin: vi.fn().mockResolvedValue({ id: 'p-1', enabled: false })
  }
}))

beforeEach(() => {
  // Reset store state
  usePluginMarketplaceStore.setState({
    marketplaceSources: [],
    installedPlugins: [],
    discoverablePlugins: [],
    isLoading: false,
    isDiscovering: false,
    isInstalling: null,
    error: null,
    searchQuery: ''
  })
})

describe('PluginMarketplaceStore', () => {
  it('has correct initial state', () => {
    const state = usePluginMarketplaceStore.getState()
    expect(state.marketplaceSources).toEqual([])
    expect(state.installedPlugins).toEqual([])
    expect(state.discoverablePlugins).toEqual([])
    expect(state.isLoading).toBe(false)
    expect(state.error).toBeNull()
  })

  it('fetches marketplace sources', async () => {
    await usePluginMarketplaceStore.getState().fetchMarketplaceSources()
    // Mocked to return empty array
    expect(usePluginMarketplaceStore.getState().marketplaceSources).toEqual([])
  })

  it('adds a marketplace source', async () => {
    const result = await usePluginMarketplaceStore.getState().addMarketplaceSource({
      name: 'test-mp',
      source_url: 'owner/repo'
    })
    expect(result).toBeDefined()
    expect(result!.name).toBe('test-mp')
    expect(usePluginMarketplaceStore.getState().marketplaceSources).toHaveLength(1)
  })

  it('removes a marketplace source', async () => {
    // First add one
    await usePluginMarketplaceStore.getState().addMarketplaceSource({
      name: 'test-mp',
      source_url: 'owner/repo'
    })
    expect(usePluginMarketplaceStore.getState().marketplaceSources).toHaveLength(1)

    const success = await usePluginMarketplaceStore.getState().removeMarketplaceSource('mp-1')
    expect(success).toBe(true)
    expect(usePluginMarketplaceStore.getState().marketplaceSources).toHaveLength(0)
  })

  it('installs a plugin', async () => {
    const result = await usePluginMarketplaceStore.getState().installPlugin('test-plugin', 'mp-1')
    expect(result).toBeDefined()
    expect(result!.name).toBe('test-plugin')
    expect(usePluginMarketplaceStore.getState().installedPlugins).toHaveLength(1)
    expect(usePluginMarketplaceStore.getState().isInstalling).toBeNull()
  })

  it('uninstalls a plugin', async () => {
    // Add first
    await usePluginMarketplaceStore.getState().installPlugin('test-plugin', 'mp-1')
    expect(usePluginMarketplaceStore.getState().installedPlugins).toHaveLength(1)

    const success = await usePluginMarketplaceStore.getState().uninstallPlugin('p-1')
    expect(success).toBe(true)
    expect(usePluginMarketplaceStore.getState().installedPlugins).toHaveLength(0)
  })

  it('sets search query', () => {
    usePluginMarketplaceStore.getState().setSearchQuery('hello')
    expect(usePluginMarketplaceStore.getState().searchQuery).toBe('hello')
  })
})
