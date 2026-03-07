/**
 * ClaudePluginManager — manages Claude Code format plugins for 20x.
 *
 * Responsibilities:
 * - Add / remove / update marketplace sources
 * - Fetch marketplace catalog (marketplace.json)
 * - Install / uninstall / enable / disable plugins
 * - Parse plugin manifests (plugin.json)
 * - Apply plugin resources: skills, MCP servers, agents
 */

import type {
  DatabaseManager,
  MarketplaceSourceRecord,
  InstalledPluginRecord,
  ClaudePluginManifest,
  ClaudePluginSource,
  CreateMarketplaceSourceData,
  CreateInstalledPluginData
} from './database'

// ── Marketplace catalog types (from marketplace.json) ──────

export interface MarketplaceOwner {
  name: string
  email?: string
}

export interface MarketplacePluginEntry {
  name: string
  source: string | ClaudePluginSource
  description?: string
  version?: string
  author?: { name: string; email?: string }
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  category?: string
  tags?: string[]
}

export interface MarketplaceCatalog {
  name: string
  owner: MarketplaceOwner
  metadata?: {
    description?: string
    version?: string
    pluginRoot?: string
  }
  plugins: MarketplacePluginEntry[]
}

// ── Discoverable plugin (for UI display) ───────────────────

export interface DiscoverablePlugin {
  name: string
  description: string
  version: string
  author: string
  category: string
  tags: string[]
  homepage: string
  repository: string
  license: string
  marketplace_id: string
  marketplace_name: string
  source: ClaudePluginSource | string
  installed: boolean
  installed_plugin_id?: string
  enabled?: boolean
}

// ── Manager class ──────────────────────────────────────────

export class ClaudePluginManager {
  /** In-memory cache of marketplace catalogs, keyed by marketplace source ID */
  private catalogCache = new Map<string, MarketplaceCatalog>()

  constructor(private db: DatabaseManager) {}

  // ── Marketplace Sources ────────────────────────────────────

  getMarketplaceSources(): MarketplaceSourceRecord[] {
    return this.db.getMarketplaceSources()
  }

  addMarketplaceSource(data: CreateMarketplaceSourceData): MarketplaceSourceRecord {
    // Prevent duplicate names
    const existing = this.db.getMarketplaceSourceByName(data.name)
    if (existing) {
      throw new Error(`Marketplace "${data.name}" already exists`)
    }
    return this.db.createMarketplaceSource(data)
  }

  removeMarketplaceSource(id: string): boolean {
    this.catalogCache.delete(id)
    return this.db.deleteMarketplaceSource(id)
  }

  // ── Fetch marketplace catalog ──────────────────────────────

  async fetchMarketplaceCatalog(sourceId: string): Promise<MarketplaceCatalog | null> {
    const source = this.db.getMarketplaceSource(sourceId)
    if (!source) return null

    try {
      const catalog = await this.fetchCatalogFromSource(source)
      if (catalog) {
        this.catalogCache.set(sourceId, catalog)
      }
      return catalog
    } catch (err) {
      console.error(`[ClaudePluginManager] Failed to fetch catalog for ${source.name}:`, err)
      return this.catalogCache.get(sourceId) ?? null
    }
  }

  private async fetchCatalogFromSource(source: MarketplaceSourceRecord): Promise<MarketplaceCatalog | null> {
    const { source_type, source_url } = source

    if (source_type === 'github') {
      return this.fetchGitHubCatalog(source_url)
    } else if (source_type === 'url') {
      return this.fetchUrlCatalog(source_url)
    } else if (source_type === 'local') {
      return this.fetchLocalCatalog(source_url)
    }

    return null
  }

  private async fetchGitHubCatalog(repoSlug: string): Promise<MarketplaceCatalog | null> {
    // repoSlug = "owner/repo" or "owner/repo#ref"
    const [repoPath, ref] = repoSlug.split('#')
    const branch = ref || 'main'
    const url = `https://raw.githubusercontent.com/${repoPath}/${branch}/.claude-plugin/marketplace.json`

    const response = await fetch(url)
    if (!response.ok) {
      // Try HEAD branch as fallback
      if (branch === 'main') {
        const fallbackUrl = `https://raw.githubusercontent.com/${repoPath}/HEAD/.claude-plugin/marketplace.json`
        const fallback = await fetch(fallbackUrl)
        if (fallback.ok) {
          return (await fallback.json()) as MarketplaceCatalog
        }
      }
      throw new Error(`Failed to fetch marketplace.json: ${response.status}`)
    }
    return (await response.json()) as MarketplaceCatalog
  }

  private async fetchUrlCatalog(url: string): Promise<MarketplaceCatalog | null> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`)
    return (await response.json()) as MarketplaceCatalog
  }

  private async fetchLocalCatalog(dirPath: string): Promise<MarketplaceCatalog | null> {
    const { readFileSync, existsSync } = await import('fs')
    const { join } = await import('path')

    // Try .claude-plugin/marketplace.json first
    let catalogPath = join(dirPath, '.claude-plugin', 'marketplace.json')
    if (!existsSync(catalogPath)) {
      // Try direct path (maybe the user pointed to marketplace.json itself)
      catalogPath = dirPath.endsWith('.json') ? dirPath : join(dirPath, 'marketplace.json')
    }

    if (!existsSync(catalogPath)) return null
    const content = readFileSync(catalogPath, 'utf-8')
    return JSON.parse(content) as MarketplaceCatalog
  }

  // ── Discover plugins from all marketplaces ─────────────────

  async discoverPlugins(searchQuery?: string): Promise<DiscoverablePlugin[]> {
    const sources = this.db.getMarketplaceSources()
    const installedPlugins = this.db.getInstalledPlugins()
    const results: DiscoverablePlugin[] = []

    for (const source of sources) {
      let catalog = this.catalogCache.get(source.id)
      if (!catalog) {
        catalog = await this.fetchMarketplaceCatalog(source.id) ?? undefined
      }
      if (!catalog) continue

      for (const entry of catalog.plugins) {
        const installed = installedPlugins.find(
          (ip) => ip.name === entry.name && ip.marketplace_id === source.id
        )

        const plugin: DiscoverablePlugin = {
          name: entry.name,
          description: entry.description || '',
          version: entry.version || '1.0.0',
          author: entry.author?.name || catalog.owner.name || '',
          category: entry.category || 'general',
          tags: entry.tags || entry.keywords || [],
          homepage: entry.homepage || '',
          repository: entry.repository || '',
          license: entry.license || '',
          marketplace_id: source.id,
          marketplace_name: source.name,
          source: entry.source,
          installed: !!installed,
          installed_plugin_id: installed?.id,
          enabled: installed?.enabled
        }
        results.push(plugin)
      }
    }

    // Filter by search query
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      return results.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)) ||
          p.category.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q)
      )
    }

    return results
  }

  // ── Install / Uninstall ────────────────────────────────────

  async installPlugin(
    pluginName: string,
    marketplaceId: string,
    scope: string = 'user'
  ): Promise<InstalledPluginRecord> {
    // Check if already installed
    const existing = this.db.getInstalledPluginByName(pluginName, marketplaceId)
    if (existing) {
      throw new Error(`Plugin "${pluginName}" is already installed`)
    }

    // Find the plugin in the catalog
    const catalog = this.catalogCache.get(marketplaceId)
    if (!catalog) {
      throw new Error('Marketplace catalog not loaded. Refresh the marketplace first.')
    }

    const entry = catalog.plugins.find((p) => p.name === pluginName)
    if (!entry) {
      throw new Error(`Plugin "${pluginName}" not found in marketplace`)
    }

    // Parse the source
    const source: ClaudePluginSource =
      typeof entry.source === 'string' ? { path: entry.source } : entry.source

    // Build manifest from marketplace entry
    const manifest: ClaudePluginManifest = {
      name: entry.name,
      version: entry.version,
      description: entry.description,
      author: entry.author,
      homepage: entry.homepage,
      repository: entry.repository,
      license: entry.license,
      keywords: entry.keywords
    }

    const data: CreateInstalledPluginData = {
      name: entry.name,
      marketplace_id: marketplaceId,
      manifest,
      source,
      scope,
      version: entry.version || '1.0.0'
    }

    const installed = this.db.createInstalledPlugin(data)

    // Auto-apply plugin resources (skills, MCP servers, etc.)
    await this.applyPluginResources(installed)

    return installed
  }

  async uninstallPlugin(pluginId: string): Promise<boolean> {
    const plugin = this.db.getInstalledPlugin(pluginId)
    if (!plugin) return false

    // Remove applied resources
    await this.removePluginResources(plugin)

    return this.db.deleteInstalledPlugin(pluginId)
  }

  enablePlugin(pluginId: string): InstalledPluginRecord | undefined {
    return this.db.updateInstalledPlugin(pluginId, { enabled: true })
  }

  disablePlugin(pluginId: string): InstalledPluginRecord | undefined {
    return this.db.updateInstalledPlugin(pluginId, { enabled: false })
  }

  // ── Installed plugins ──────────────────────────────────────

  getInstalledPlugins(): InstalledPluginRecord[] {
    return this.db.getInstalledPlugins()
  }

  // ── Apply / remove plugin resources ────────────────────────

  /**
   * Apply plugin resources (skills, MCP servers, agents) to the local DB.
   * For now, this creates skills from the plugin manifest/catalog entry.
   * Future: also register MCP servers, agents, hooks.
   */
  private async applyPluginResources(plugin: InstalledPluginRecord): Promise<void> {
    const manifest = plugin.manifest

    // Auto-create skills from manifest keywords/description
    if (manifest.skills && Array.isArray(manifest.skills)) {
      for (const skillPath of manifest.skills) {
        try {
          // Create a skill entry referencing the plugin
          this.db.createSkill({
            name: `${plugin.name}:${typeof skillPath === 'string' ? skillPath.replace(/\//g, '-').replace(/^-/, '') : 'skill'}`,
            description: `Skill from plugin "${plugin.name}"`,
            content: `Plugin skill: ${skillPath}`,
            tags: ['plugin', plugin.name]
          })
        } catch (err) {
          console.warn(`[ClaudePluginManager] Failed to create skill from plugin:`, err)
        }
      }
    }

    // Auto-register MCP servers from manifest
    if (manifest.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)) {
      const servers = manifest.mcpServers as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
      for (const [serverName, serverConfig] of Object.entries(servers)) {
        try {
          this.db.createMcpServer({
            name: `${plugin.name}:${serverName}`,
            command: serverConfig.command || '',
            args: serverConfig.args || [],
            environment: serverConfig.env || {}
          })
        } catch (err) {
          console.warn(`[ClaudePluginManager] Failed to create MCP server from plugin:`, err)
        }
      }
    }
  }

  private async removePluginResources(plugin: InstalledPluginRecord): Promise<void> {
    // Remove skills created by this plugin
    const skills = this.db.getSkills()
    const pluginSkills = skills.filter((s) => s.tags.includes('plugin') && s.tags.includes(plugin.name))
    for (const skill of pluginSkills) {
      this.db.deleteSkill(skill.id)
    }

    // Remove MCP servers created by this plugin
    const mcpServers = this.db.getMcpServers()
    const pluginServers = mcpServers.filter((s) => s.name.startsWith(`${plugin.name}:`))
    for (const server of pluginServers) {
      this.db.deleteMcpServer(server.id)
    }
  }
}
