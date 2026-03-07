import { create } from 'zustand'
import type { MarketplaceSource, InstalledPlugin, DiscoverablePlugin } from '@/types'
import { claudePluginApi } from '@/lib/ipc-client'

interface PluginMarketplaceState {
  // Data
  marketplaceSources: MarketplaceSource[]
  installedPlugins: InstalledPlugin[]
  discoverablePlugins: DiscoverablePlugin[]

  // UI state
  isLoading: boolean
  isDiscovering: boolean
  isInstalling: string | null // plugin name being installed
  error: string | null
  searchQuery: string

  // Actions
  fetchMarketplaceSources: () => Promise<void>
  fetchInstalledPlugins: () => Promise<void>
  discoverPlugins: (searchQuery?: string) => Promise<void>
  addMarketplaceSource: (data: { name: string; source_type?: string; source_url: string; auto_update?: boolean }) => Promise<MarketplaceSource | null>
  removeMarketplaceSource: (id: string) => Promise<boolean>
  refreshMarketplace: (sourceId: string) => Promise<void>
  installPlugin: (pluginName: string, marketplaceId: string, scope?: string) => Promise<InstalledPlugin | null>
  uninstallPlugin: (pluginId: string) => Promise<boolean>
  enablePlugin: (pluginId: string) => Promise<void>
  disablePlugin: (pluginId: string) => Promise<void>
  setSearchQuery: (query: string) => void
}

export const usePluginMarketplaceStore = create<PluginMarketplaceState>((set, get) => ({
  marketplaceSources: [],
  installedPlugins: [],
  discoverablePlugins: [],
  isLoading: false,
  isDiscovering: false,
  isInstalling: null,
  error: null,
  searchQuery: '',

  fetchMarketplaceSources: async () => {
    try {
      const sources = await claudePluginApi.getMarketplaceSources()
      set({ marketplaceSources: sources })
    } catch (err) {
      set({ error: String(err) })
    }
  },

  fetchInstalledPlugins: async () => {
    set({ isLoading: true, error: null })
    try {
      const plugins = await claudePluginApi.getInstalledPlugins()
      set({ installedPlugins: plugins, isLoading: false })
    } catch (err) {
      set({ error: String(err), isLoading: false })
    }
  },

  discoverPlugins: async (searchQuery?: string) => {
    set({ isDiscovering: true, error: null })
    try {
      const plugins = await claudePluginApi.discoverPlugins(searchQuery)
      set({ discoverablePlugins: plugins, isDiscovering: false })
    } catch (err) {
      set({ error: String(err), isDiscovering: false })
    }
  },

  addMarketplaceSource: async (data) => {
    try {
      const source = await claudePluginApi.addMarketplaceSource(data)
      set((state) => ({ marketplaceSources: [...state.marketplaceSources, source] }))
      // Fetch the catalog immediately
      await claudePluginApi.fetchCatalog(source.id)
      // Refresh discoverable plugins
      await get().discoverPlugins(get().searchQuery || undefined)
      return source
    } catch (err) {
      set({ error: String(err) })
      return null
    }
  },

  removeMarketplaceSource: async (id) => {
    try {
      const success = await claudePluginApi.removeMarketplaceSource(id)
      if (success) {
        set((state) => ({
          marketplaceSources: state.marketplaceSources.filter((s) => s.id !== id),
          // Remove discoverable plugins from this marketplace
          discoverablePlugins: state.discoverablePlugins.filter((p) => p.marketplace_id !== id),
          // Remove installed plugins from this marketplace
          installedPlugins: state.installedPlugins.filter((p) => p.marketplace_id !== id)
        }))
      }
      return success
    } catch (err) {
      set({ error: String(err) })
      return false
    }
  },

  refreshMarketplace: async (sourceId) => {
    try {
      await claudePluginApi.fetchCatalog(sourceId)
      await get().discoverPlugins(get().searchQuery || undefined)
    } catch (err) {
      set({ error: String(err) })
    }
  },

  installPlugin: async (pluginName, marketplaceId, scope) => {
    set({ isInstalling: pluginName, error: null })
    try {
      const installed = await claudePluginApi.installPlugin(pluginName, marketplaceId, scope)
      set((state) => ({
        installedPlugins: [...state.installedPlugins, installed],
        isInstalling: null,
        // Update discoverable plugins to reflect installed state
        discoverablePlugins: state.discoverablePlugins.map((p) =>
          p.name === pluginName && p.marketplace_id === marketplaceId
            ? { ...p, installed: true, installed_plugin_id: installed.id, enabled: true }
            : p
        )
      }))
      return installed
    } catch (err) {
      set({ error: String(err), isInstalling: null })
      return null
    }
  },

  uninstallPlugin: async (pluginId) => {
    try {
      const success = await claudePluginApi.uninstallPlugin(pluginId)
      if (success) {
        set((state) => ({
          installedPlugins: state.installedPlugins.filter((p) => p.id !== pluginId),
          // Update discoverable plugins
          discoverablePlugins: state.discoverablePlugins.map((p) =>
            p.installed_plugin_id === pluginId
              ? { ...p, installed: false, installed_plugin_id: undefined, enabled: undefined }
              : p
          )
        }))
      }
      return success
    } catch (err) {
      set({ error: String(err) })
      return false
    }
  },

  enablePlugin: async (pluginId) => {
    try {
      const updated = await claudePluginApi.enablePlugin(pluginId)
      if (updated) {
        set((state) => ({
          installedPlugins: state.installedPlugins.map((p) => (p.id === pluginId ? { ...p, enabled: true } : p)),
          discoverablePlugins: state.discoverablePlugins.map((p) =>
            p.installed_plugin_id === pluginId ? { ...p, enabled: true } : p
          )
        }))
      }
    } catch (err) {
      set({ error: String(err) })
    }
  },

  disablePlugin: async (pluginId) => {
    try {
      const updated = await claudePluginApi.disablePlugin(pluginId)
      if (updated) {
        set((state) => ({
          installedPlugins: state.installedPlugins.map((p) => (p.id === pluginId ? { ...p, enabled: false } : p)),
          discoverablePlugins: state.discoverablePlugins.map((p) =>
            p.installed_plugin_id === pluginId ? { ...p, enabled: false } : p
          )
        }))
      }
    } catch (err) {
      set({ error: String(err) })
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query })
}))
