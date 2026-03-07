import { useState, useEffect, useCallback } from 'react'
import { Search, Plus, Trash2, Download, Power, PowerOff, RefreshCw, Loader2, ExternalLink, Store, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SettingsSection } from '../SettingsSection'
import { usePluginMarketplaceStore } from '@/stores/plugin-marketplace-store'
import type { DiscoverablePlugin, InstalledPlugin } from '@/types'

export function PluginsSettings() {
  const {
    marketplaceSources,
    installedPlugins,
    discoverablePlugins,
    isLoading,
    isDiscovering,
    isInstalling,
    error,
    searchQuery,
    fetchMarketplaceSources,
    fetchInstalledPlugins,
    discoverPlugins,
    addMarketplaceSource,
    removeMarketplaceSource,
    refreshMarketplace,
    installPlugin,
    uninstallPlugin,
    enablePlugin,
    disablePlugin,
    setSearchQuery
  } = usePluginMarketplaceStore()

  const [activeTab, setActiveTab] = useState<'installed' | 'discover' | 'marketplaces'>('installed')
  const [showAddMarketplace, setShowAddMarketplace] = useState(false)
  const [newMarketplace, setNewMarketplace] = useState({ name: '', source_url: '', source_type: 'github' })

  // Load data on mount
  useEffect(() => {
    fetchMarketplaceSources()
    fetchInstalledPlugins()
  }, [])

  // Load discoverable plugins when switching to discover tab
  useEffect(() => {
    if (activeTab === 'discover') {
      discoverPlugins(searchQuery || undefined)
    }
  }, [activeTab])

  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query)
      if (activeTab === 'discover') {
        discoverPlugins(query || undefined)
      }
    },
    [activeTab]
  )

  const handleAddMarketplace = async () => {
    if (!newMarketplace.name || !newMarketplace.source_url) return
    await addMarketplaceSource({
      name: newMarketplace.name,
      source_type: newMarketplace.source_type,
      source_url: newMarketplace.source_url
    })
    setNewMarketplace({ name: '', source_url: '', source_type: 'github' })
    setShowAddMarketplace(false)
  }

  const filteredInstalled = searchQuery
    ? installedPlugins.filter(
        (p) =>
          p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (p.manifest.description || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    : installedPlugins

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Plugins"
        description="Extend 20x with Claude Code format plugins. Browse marketplaces, install skills, MCP servers, agents, and more."
      >
        {/* Tab bar */}
        <div className="flex gap-1 border-b border-border">
          {(['installed', 'discover', 'marketplaces'] as const).map((tab) => (
            <button
              key={tab}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'installed' && `Installed (${installedPlugins.length})`}
              {tab === 'discover' && 'Discover'}
              {tab === 'marketplaces' && `Marketplaces (${marketplaceSources.length})`}
            </button>
          ))}
        </div>

        {/* Search bar */}
        {(activeTab === 'installed' || activeTab === 'discover') && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={activeTab === 'installed' ? 'Search installed plugins...' : 'Search plugins...'}
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              className="pl-10"
            />
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Installed tab */}
        {activeTab === 'installed' && (
          <div className="space-y-3">
            {isLoading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Loading plugins...
              </div>
            ) : filteredInstalled.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Store className="h-10 w-10 mx-auto mb-3 opacity-40" />
                <p className="text-sm font-medium">No plugins installed</p>
                <p className="text-xs mt-1">
                  Browse the Discover tab to find and install plugins from marketplaces.
                </p>
              </div>
            ) : (
              filteredInstalled.map((plugin) => (
                <InstalledPluginCard
                  key={plugin.id}
                  plugin={plugin}
                  onUninstall={() => uninstallPlugin(plugin.id)}
                  onEnable={() => enablePlugin(plugin.id)}
                  onDisable={() => disablePlugin(plugin.id)}
                />
              ))
            )}
          </div>
        )}

        {/* Discover tab */}
        {activeTab === 'discover' && (
          <div className="space-y-3">
            {marketplaceSources.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Store className="h-10 w-10 mx-auto mb-3 opacity-40" />
                <p className="text-sm font-medium">No marketplaces configured</p>
                <p className="text-xs mt-1">
                  Add a marketplace in the Marketplaces tab to browse available plugins.
                </p>
              </div>
            ) : isDiscovering ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Discovering plugins...
              </div>
            ) : discoverablePlugins.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Search className="h-10 w-10 mx-auto mb-3 opacity-40" />
                <p className="text-sm font-medium">
                  {searchQuery ? 'No plugins match your search' : 'No plugins found'}
                </p>
                <p className="text-xs mt-1">
                  {searchQuery
                    ? 'Try a different search term.'
                    : 'Try refreshing your marketplaces or adding new ones.'}
                </p>
              </div>
            ) : (
              discoverablePlugins.map((plugin) => (
                <DiscoverPluginCard
                  key={`${plugin.marketplace_id}-${plugin.name}`}
                  plugin={plugin}
                  isInstalling={isInstalling === plugin.name}
                  onInstall={() => installPlugin(plugin.name, plugin.marketplace_id)}
                  onUninstall={() => plugin.installed_plugin_id && uninstallPlugin(plugin.installed_plugin_id)}
                />
              ))
            )}
          </div>
        )}

        {/* Marketplaces tab */}
        {activeTab === 'marketplaces' && (
          <div className="space-y-3">
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowAddMarketplace(true)}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Marketplace
              </Button>
            </div>

            {showAddMarketplace && (
              <div className="rounded-md border border-border bg-card p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium">Add Plugin Marketplace</h4>
                  <button onClick={() => setShowAddMarketplace(false)} className="text-muted-foreground hover:text-foreground">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="space-y-2">
                  <Input
                    placeholder="Marketplace name (e.g. my-team-plugins)"
                    value={newMarketplace.name}
                    onChange={(e) => setNewMarketplace((s) => ({ ...s, name: e.target.value }))}
                  />
                  <div className="flex gap-2">
                    <select
                      className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground"
                      value={newMarketplace.source_type}
                      onChange={(e) => setNewMarketplace((s) => ({ ...s, source_type: e.target.value }))}
                    >
                      <option value="github">GitHub</option>
                      <option value="url">URL</option>
                      <option value="local">Local Path</option>
                    </select>
                    <Input
                      className="flex-1"
                      placeholder={
                        newMarketplace.source_type === 'github'
                          ? 'owner/repo (e.g. anthropics/claude-code)'
                          : newMarketplace.source_type === 'url'
                            ? 'https://example.com/marketplace.json'
                            : '/path/to/marketplace'
                      }
                      value={newMarketplace.source_url}
                      onChange={(e) => setNewMarketplace((s) => ({ ...s, source_url: e.target.value }))}
                    />
                  </div>
                  <div className="flex justify-end">
                    <Button size="sm" onClick={handleAddMarketplace} disabled={!newMarketplace.name || !newMarketplace.source_url}>
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {marketplaceSources.length === 0 && !showAddMarketplace ? (
              <div className="text-center py-8 text-muted-foreground">
                <Store className="h-10 w-10 mx-auto mb-3 opacity-40" />
                <p className="text-sm font-medium">No marketplaces configured</p>
                <p className="text-xs mt-1">
                  Add a Claude Code plugin marketplace to browse and install plugins.
                  <br />
                  Try <code className="px-1 py-0.5 bg-muted rounded text-xs">anthropics/claude-code</code> for the official demo marketplace.
                </p>
              </div>
            ) : (
              marketplaceSources.map((source) => (
                <MarketplaceSourceCard
                  key={source.id}
                  source={source}
                  onRefresh={() => refreshMarketplace(source.id)}
                  onRemove={() => removeMarketplaceSource(source.id)}
                />
              ))
            )}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────

function InstalledPluginCard({
  plugin,
  onUninstall,
  onEnable,
  onDisable
}: {
  plugin: InstalledPlugin
  onUninstall: () => void
  onEnable: () => void
  onDisable: () => void
}) {
  const [confirmUninstall, setConfirmUninstall] = useState(false)

  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium text-foreground truncate">{plugin.name}</h4>
            <span className="text-xs text-muted-foreground">v{plugin.version}</span>
            <span
              className={`text-xs px-1.5 py-0.5 rounded-full ${
                plugin.enabled
                  ? 'bg-green-500/10 text-green-500'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {plugin.enabled ? 'Enabled' : 'Disabled'}
            </span>
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              {plugin.scope}
            </span>
          </div>
          {plugin.manifest.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {plugin.manifest.description}
            </p>
          )}
          {plugin.manifest.keywords && plugin.manifest.keywords.length > 0 && (
            <div className="flex gap-1 mt-1.5 flex-wrap">
              {plugin.manifest.keywords.slice(0, 5).map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 ml-3 shrink-0">
          {plugin.enabled ? (
            <Button variant="ghost" size="icon" onClick={onDisable} title="Disable plugin">
              <PowerOff className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button variant="ghost" size="icon" onClick={onEnable} title="Enable plugin">
              <Power className="h-3.5 w-3.5" />
            </Button>
          )}
          {confirmUninstall ? (
            <div className="flex items-center gap-1">
              <Button variant="destructive" size="sm" onClick={() => { onUninstall(); setConfirmUninstall(false) }}>
                Remove
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmUninstall(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="icon" onClick={() => setConfirmUninstall(true)} title="Uninstall plugin">
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function DiscoverPluginCard({
  plugin,
  isInstalling,
  onInstall,
  onUninstall
}: {
  plugin: DiscoverablePlugin
  isInstalling: boolean
  onInstall: () => void
  onUninstall: () => void
}) {
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium text-foreground truncate">{plugin.name}</h4>
            <span className="text-xs text-muted-foreground">v{plugin.version}</span>
            {plugin.author && (
              <span className="text-xs text-muted-foreground">by {plugin.author}</span>
            )}
          </div>
          {plugin.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {plugin.description}
            </p>
          )}
          <div className="flex items-center gap-2 mt-1.5">
            {plugin.category && plugin.category !== 'general' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">
                {plugin.category}
              </span>
            )}
            {plugin.tags.slice(0, 4).map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
              >
                {tag}
              </span>
            ))}
            <span className="text-[10px] text-muted-foreground">
              from {plugin.marketplace_name}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 ml-3 shrink-0">
          {plugin.homepage && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => window.electronAPI?.shell?.openExternal?.(plugin.homepage)}
              title="View homepage"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
          {plugin.installed ? (
            <Button variant="outline" size="sm" onClick={onUninstall}>
              <Trash2 className="h-3 w-3 mr-1" />
              Remove
            </Button>
          ) : (
            <Button size="sm" onClick={onInstall} disabled={isInstalling}>
              {isInstalling ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  Installing...
                </>
              ) : (
                <>
                  <Download className="h-3 w-3 mr-1" />
                  Install
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function MarketplaceSourceCard({
  source,
  onRefresh,
  onRemove
}: {
  source: { id: string; name: string; source_type: string; source_url: string }
  onRefresh: () => void
  onRemove: () => void
}) {
  const [confirmRemove, setConfirmRemove] = useState(false)

  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Store className="h-4 w-4 text-muted-foreground shrink-0" />
            <h4 className="text-sm font-medium text-foreground truncate">{source.name}</h4>
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              {source.source_type}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate ml-6">{source.source_url}</p>
        </div>
        <div className="flex items-center gap-1 ml-3 shrink-0">
          <Button variant="ghost" size="icon" onClick={onRefresh} title="Refresh marketplace">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          {confirmRemove ? (
            <div className="flex items-center gap-1">
              <Button variant="destructive" size="sm" onClick={() => { onRemove(); setConfirmRemove(false) }}>
                Remove
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="icon" onClick={() => setConfirmRemove(true)} title="Remove marketplace">
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
