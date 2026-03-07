/**
 * ClaudePluginManager — manages Claude Code format plugins for 20x.
 *
 * Responsibilities:
 * - Add / remove / update marketplace sources
 * - Fetch marketplace catalog (marketplace.json)
 * - Install / uninstall / enable / disable plugins
 * - Download plugin files from GitHub/URL/local sources
 * - Parse plugin manifests (plugin.json) and actual plugin files
 * - Apply plugin resources: skills (from skills/ & commands/), MCP servers (from .mcp.json)
 */

import { join } from 'path'
import { tmpdir } from 'os'

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

// ── Plugin resources (what a plugin added) ──────────────────

export interface PluginResources {
  skills: { id: string; name: string; description: string }[]
  mcpServers: { id: string; name: string; command: string; args: string[] }[]
  agents: { id: string; name: string; description: string }[]
  commands: string[]
}

// ── GitHub API types for content listing ────────────────────

interface GitHubContentEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'symlink'
  download_url: string | null
}

// ── Manager class ──────────────────────────────────────────

/** Default marketplaces seeded on first run */
const DEFAULT_MARKETPLACES: CreateMarketplaceSourceData[] = [
  {
    name: 'anthropic-official',
    source_type: 'github',
    source_url: 'anthropics/claude-plugins-official'
  },
  {
    name: 'claude-code-plugins',
    source_type: 'github',
    source_url: 'anthropics/claude-code'
  }
]

export class ClaudePluginManager {
  /** In-memory cache of marketplace catalogs, keyed by marketplace source ID */
  private catalogCache = new Map<string, MarketplaceCatalog>()

  /** Base directory for downloaded plugin files */
  private pluginsDir: string

  constructor(
    private db: DatabaseManager,
    pluginsDir?: string
  ) {
    // Default to <userData>/plugins if not specified
    if (pluginsDir) {
      this.pluginsDir = pluginsDir
    } else {
      this.pluginsDir = join(tmpdir(), '20x-plugins')
      try {
        // Dynamic import for electron (only available in main process)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electron = require('electron') as typeof import('electron')
        this.pluginsDir = join(electron.app.getPath('userData'), 'plugins')
      } catch {
        // Fallback for tests — already set above
      }
    }

    this.ensureDefaultMarketplaces()
  }

  /**
   * Seeds the default Anthropic marketplace sources if none exist yet.
   * - anthropic-official: curated directory of popular Claude Code extensions (LSPs, tools, integrations)
   * - claude-code-plugins: bundled plugins from the claude-code repo (code-review, feature-dev, commit-commands, etc.)
   */
  private ensureDefaultMarketplaces(): void {
    const existing = this.db.getMarketplaceSources()
    if (existing.length > 0) return // user already has marketplace sources configured

    for (const marketplace of DEFAULT_MARKETPLACES) {
      try {
        this.db.createMarketplaceSource(marketplace)
      } catch (err) {
        console.warn(`[ClaudePluginManager] Failed to seed default marketplace "${marketplace.name}":`, err)
      }
    }
  }

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

    // Resolve the marketplace source for download context
    const marketplaceSource = this.db.getMarketplaceSource(marketplaceId)

    // Download actual plugin files
    const pluginDir = await this.downloadPluginFiles(
      pluginName,
      source,
      marketplaceSource ?? undefined,
      catalog.metadata?.pluginRoot
    )

    // Read the real manifest from plugin.json if it exists, or build from catalog entry
    const manifest = await this.readPluginManifest(pluginDir, entry)

    const data: CreateInstalledPluginData = {
      name: entry.name,
      marketplace_id: marketplaceId,
      manifest,
      source,
      scope,
      version: entry.version || '1.0.0'
    }

    const installed = this.db.createInstalledPlugin(data)

    // Apply plugin resources from downloaded files (skills, commands → 20x skills; .mcp.json → 20x MCP servers)
    await this.applyPluginResources(installed, pluginDir)

    return installed
  }

  async uninstallPlugin(pluginId: string): Promise<boolean> {
    const plugin = this.db.getInstalledPlugin(pluginId)
    if (!plugin) return false

    // Remove applied resources
    await this.removePluginResources(plugin)

    // Clean up downloaded plugin files
    await this.cleanupPluginFiles(plugin.name)

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

  /**
   * Returns the concrete resources (skills, MCP servers) that were created
   * when a plugin was installed, plus manifest-declared agents and commands.
   */
  getPluginResources(pluginId: string): PluginResources {
    const plugin = this.db.getInstalledPlugin(pluginId)
    if (!plugin) return { skills: [], mcpServers: [], agents: [], commands: [] }

    const manifest = plugin.manifest

    // Materialised skills (tagged with ['plugin', pluginName])
    const allSkills = this.db.getSkills()
    const skills = allSkills
      .filter((s) => s.tags.includes('plugin') && s.tags.includes(plugin.name))
      .map((s) => ({ id: s.id, name: s.name, description: s.description }))

    // Materialised MCP servers (prefixed with pluginName:)
    const allMcp = this.db.getMcpServers()
    const mcpServers = allMcp
      .filter((s) => s.name.startsWith(`${plugin.name}:`))
      .map((s) => ({ id: s.id, name: s.name, command: s.command, args: s.args }))

    // Materialised agents (prefixed with pluginName:)
    const allAgents = this.db.getAgents()
    const agents = allAgents
      .filter((a) => a.name.startsWith(`${plugin.name}:`))
      .map((a) => ({ id: a.id, name: a.name, description: a.config?.system_prompt?.slice(0, 100) || '' }))

    // Commands — already materialised as skills, but list them for informational display
    const commands: string[] = manifest.commands
      ? (Array.isArray(manifest.commands) ? manifest.commands : [manifest.commands])
      : []

    return { skills, mcpServers, agents, commands }
  }

  // ── Download plugin files ─────────────────────────────────

  /**
   * Downloads plugin files from the source (GitHub, URL, or local) into
   * the local plugins directory at <pluginsDir>/<pluginName>/
   */
  private async downloadPluginFiles(
    pluginName: string,
    source: ClaudePluginSource,
    marketplaceSource?: MarketplaceSourceRecord,
    pluginRoot?: string
  ): Promise<string> {
    const { join } = await import('path')
    const { mkdirSync, existsSync } = await import('fs')

    const pluginDir = join(this.pluginsDir, pluginName)
    if (!existsSync(this.pluginsDir)) {
      mkdirSync(this.pluginsDir, { recursive: true })
    }
    if (!existsSync(pluginDir)) {
      mkdirSync(pluginDir, { recursive: true })
    }

    // Determine how to download based on source type
    if (source.source === 'github' && source.repo) {
      // Source explicitly points to a GitHub repo
      await this.downloadFromGitHub(source.repo, source.ref || 'main', source.path || '', pluginDir)
    } else if (source.path && marketplaceSource?.source_type === 'github') {
      // Source is a relative path within the marketplace's GitHub repo
      const repoSlug = marketplaceSource.source_url
      const [repoPath, ref] = repoSlug.split('#')
      const branch = ref || 'main'

      // Resolve the full path within the repo
      let remotePath = source.path.replace(/^\.\//, '')
      if (pluginRoot) {
        remotePath = `${pluginRoot.replace(/^\.\//, '')}/${remotePath}`
      }

      await this.downloadFromGitHub(repoPath, branch, remotePath, pluginDir)
    } else if (source.url) {
      // Source is a URL — download as a tarball or single file
      await this.downloadFromUrl(source.url, pluginDir)
    } else if (source.path && marketplaceSource?.source_type === 'local') {
      // Source is a local path
      await this.copyFromLocal(
        marketplaceSource.source_url,
        source.path,
        pluginRoot,
        pluginDir
      )
    }

    return pluginDir
  }

  /**
   * Downloads a directory from a GitHub repository using the Contents API.
   * Falls back to raw.githubusercontent.com for individual files.
   */
  private async downloadFromGitHub(
    repoPath: string,
    branch: string,
    remotePath: string,
    localDir: string
  ): Promise<void> {
    const { writeFileSync, mkdirSync } = await import('fs')
    const { join } = await import('path')

    // Use GitHub API to list directory contents
    const apiUrl = `https://api.github.com/repos/${repoPath}/contents/${remotePath}?ref=${branch}`

    try {
      const response = await fetch(apiUrl, {
        headers: { Accept: 'application/vnd.github.v3+json' }
      })

      if (!response.ok) {
        // Maybe it's a single file, not a directory
        if (response.status === 404) {
          console.warn(`[ClaudePluginManager] Path not found on GitHub: ${remotePath}`)
          return
        }
        throw new Error(`GitHub API error: ${response.status}`)
      }

      const data = await response.json()

      if (Array.isArray(data)) {
        // It's a directory listing
        for (const entry of data as GitHubContentEntry[]) {
          if (entry.type === 'file' && entry.download_url) {
            const fileResponse = await fetch(entry.download_url)
            if (fileResponse.ok) {
              const content = await fileResponse.text()
              const localPath = join(localDir, entry.name)
              writeFileSync(localPath, content, 'utf-8')
            }
          } else if (entry.type === 'dir') {
            // Recursively download subdirectories
            const subDir = join(localDir, entry.name)
            mkdirSync(subDir, { recursive: true })
            await this.downloadFromGitHub(
              repoPath,
              branch,
              `${remotePath}/${entry.name}`,
              subDir
            )
          }
        }
      } else if (data.type === 'file' && data.download_url) {
        // Single file
        const fileResponse = await fetch(data.download_url)
        if (fileResponse.ok) {
          const content = await fileResponse.text()
          const fileName = remotePath.split('/').pop() || 'file'
          writeFileSync(join(localDir, fileName), content, 'utf-8')
        }
      }
    } catch (err) {
      console.error(`[ClaudePluginManager] Failed to download from GitHub (${repoPath}/${remotePath}):`, err)
      // Try raw.githubusercontent.com as fallback for known file patterns
      await this.downloadKnownFilesRaw(repoPath, branch, remotePath, localDir)
    }
  }

  /**
   * Fallback: try to download known Claude Code plugin files directly via
   * raw.githubusercontent.com when the GitHub API is unavailable (rate-limited, etc.)
   */
  private async downloadKnownFilesRaw(
    repoPath: string,
    branch: string,
    remotePath: string,
    localDir: string
  ): Promise<void> {
    const { writeFileSync, mkdirSync } = await import('fs')
    const { join } = await import('path')

    const baseUrl = `https://raw.githubusercontent.com/${repoPath}/${branch}/${remotePath}`

    // Try known Claude Code plugin files
    const knownFiles = [
      'plugin.json',
      '.mcp.json',
      'CLAUDE.md'
    ]

    for (const file of knownFiles) {
      try {
        const url = `${baseUrl}/${file}`
        const response = await fetch(url)
        if (response.ok) {
          const content = await response.text()
          writeFileSync(join(localDir, file), content, 'utf-8')
        }
      } catch {
        // Skip files that don't exist
      }
    }

    // Try to download skills/ and commands/ directories
    // We can't list directories via raw.githubusercontent.com, so we try
    // well-known filenames from the manifest if available
    const knownDirs = ['skills', 'commands']
    for (const dir of knownDirs) {
      try {
        // Try a README or index file in the directory to check if it exists
        const testUrl = `${baseUrl}/${dir}/`
        const response = await fetch(testUrl)
        if (response.ok) {
          mkdirSync(join(localDir, dir), { recursive: true })
        }
      } catch {
        // Skip
      }
    }
  }

  private async downloadFromUrl(url: string, localDir: string): Promise<void> {
    const { writeFileSync, mkdirSync } = await import('fs')
    const { join } = await import('path')

    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`)

      const contentType = response.headers.get('content-type') || ''

      if (contentType.includes('application/json') || url.endsWith('.json')) {
        // Single JSON file (e.g., plugin.json)
        const content = await response.text()
        const fileName = url.split('/').pop() || 'plugin.json'
        writeFileSync(join(localDir, fileName), content, 'utf-8')
      } else {
        // Could be a tarball or zip — for now, save as-is
        const buffer = Buffer.from(await response.arrayBuffer())
        const fileName = url.split('/').pop() || 'plugin-archive'
        writeFileSync(join(localDir, fileName), buffer)
      }
    } catch (err) {
      console.warn(`[ClaudePluginManager] Failed to download from URL ${url}:`, err)
    }

    // Also check for plugin.json at the URL base
    if (!url.endsWith('plugin.json')) {
      const baseUrl = url.replace(/\/[^/]*$/, '')
      try {
        const manifestUrl = `${baseUrl}/plugin.json`
        const response = await fetch(manifestUrl)
        if (response.ok) {
          const content = await response.text()
          writeFileSync(join(localDir, 'plugin.json'), content, 'utf-8')
        }
      } catch {
        // Optional
      }
    }

    void mkdirSync // avoid unused warning
  }

  private async copyFromLocal(
    marketplacePath: string,
    pluginPath: string,
    pluginRoot: string | undefined,
    localDir: string
  ): Promise<void> {
    const { cpSync, existsSync } = await import('fs')
    const { join, resolve } = await import('path')

    let sourcePath = pluginPath.replace(/^\.\//, '')
    if (pluginRoot) {
      sourcePath = `${pluginRoot.replace(/^\.\//, '')}/${sourcePath}`
    }

    // Resolve relative to marketplace directory
    const baseDir = marketplacePath.endsWith('.json')
      ? resolve(marketplacePath, '..')
      : marketplacePath
    const fullSourcePath = join(baseDir, sourcePath)

    if (existsSync(fullSourcePath)) {
      cpSync(fullSourcePath, localDir, { recursive: true })
    }
  }

  // ── Read plugin manifest ──────────────────────────────────

  /**
   * Reads plugin.json from the downloaded plugin directory if it exists,
   * falling back to building a manifest from the marketplace catalog entry.
   */
  private async readPluginManifest(
    pluginDir: string,
    entry: MarketplacePluginEntry
  ): Promise<ClaudePluginManifest> {
    const { readFileSync, existsSync } = await import('fs')
    const { join } = await import('path')

    const manifestPath = join(pluginDir, 'plugin.json')
    if (existsSync(manifestPath)) {
      try {
        const raw = readFileSync(manifestPath, 'utf-8')
        const parsed = JSON.parse(raw) as ClaudePluginManifest
        // Merge with catalog entry data (catalog may have extra fields)
        return {
          ...parsed,
          name: parsed.name || entry.name,
          version: parsed.version || entry.version,
          description: parsed.description || entry.description,
          author: parsed.author || entry.author,
          homepage: parsed.homepage || entry.homepage,
          repository: parsed.repository || entry.repository,
          license: parsed.license || entry.license,
          keywords: parsed.keywords || entry.keywords
        }
      } catch (err) {
        console.warn(`[ClaudePluginManager] Failed to parse plugin.json:`, err)
      }
    }

    // Fallback: build manifest from marketplace entry
    return {
      name: entry.name,
      version: entry.version,
      description: entry.description,
      author: entry.author,
      homepage: entry.homepage,
      repository: entry.repository,
      license: entry.license,
      keywords: entry.keywords
    }
  }

  // ── Apply / remove plugin resources ────────────────────────

  /**
   * Apply plugin resources from downloaded files to the local DB.
   * - skills/ directories → 20x Skills (reads SKILL.md or *.md files)
   * - commands/ directory → 20x Skills (commands are skills too)
   * - .mcp.json → 20x MCP Servers
   * All resources are tagged/prefixed with the plugin name for lifecycle management.
   */
  private async applyPluginResources(
    plugin: InstalledPluginRecord,
    pluginDir: string
  ): Promise<void> {
    const { readFileSync, existsSync, readdirSync, statSync } = await import('fs')
    const { join, basename } = await import('path')

    // ── 1. Skills from skills/ directory ──────────────────────
    const skillsDir = join(pluginDir, 'skills')
    if (existsSync(skillsDir)) {
      const entries = readdirSync(skillsDir)
      for (const entry of entries) {
        const entryPath = join(skillsDir, entry)
        const stat = statSync(entryPath)

        if (stat.isDirectory()) {
          // Claude Code format: skills/<skill-name>/SKILL.md
          const skillMdPath = join(entryPath, 'SKILL.md')
          if (existsSync(skillMdPath)) {
            const content = readFileSync(skillMdPath, 'utf-8')
            const { title, description } = this.parseMarkdownFrontmatter(content, entry)
            this.createPluginSkill(plugin.name, entry, title, description, content)
          } else {
            // Try any .md file in the directory
            const mdFiles = readdirSync(entryPath).filter((f) => f.endsWith('.md'))
            for (const mdFile of mdFiles) {
              const content = readFileSync(join(entryPath, mdFile), 'utf-8')
              const skillName = basename(mdFile, '.md')
              const { title, description } = this.parseMarkdownFrontmatter(content, skillName)
              this.createPluginSkill(plugin.name, `${entry}/${skillName}`, title, description, content)
            }
          }
        } else if (stat.isFile() && entry.endsWith('.md')) {
          // Direct .md file in skills/
          const content = readFileSync(entryPath, 'utf-8')
          const skillName = basename(entry, '.md')
          const { title, description } = this.parseMarkdownFrontmatter(content, skillName)
          this.createPluginSkill(plugin.name, skillName, title, description, content)
        }
      }
    }

    // ── 2. Commands from commands/ directory → also 20x Skills ─
    const commandsDir = join(pluginDir, 'commands')
    if (existsSync(commandsDir)) {
      const entries = readdirSync(commandsDir)
      for (const entry of entries) {
        const entryPath = join(commandsDir, entry)
        const stat = statSync(entryPath)

        if (stat.isFile() && entry.endsWith('.md')) {
          const content = readFileSync(entryPath, 'utf-8')
          const cmdName = basename(entry, '.md')
          const { title, description } = this.parseMarkdownFrontmatter(content, cmdName)
          this.createPluginSkill(
            plugin.name,
            `cmd:${cmdName}`,
            title || `Command: ${cmdName}`,
            description || `Command "${cmdName}" from plugin "${plugin.name}"`,
            content
          )
        } else if (stat.isDirectory()) {
          // commands/<cmd-name>/ directory with .md files inside
          const mdFiles = readdirSync(entryPath).filter((f) => f.endsWith('.md'))
          for (const mdFile of mdFiles) {
            const content = readFileSync(join(entryPath, mdFile), 'utf-8')
            const cmdName = basename(mdFile, '.md')
            const { title, description } = this.parseMarkdownFrontmatter(content, cmdName)
            this.createPluginSkill(
              plugin.name,
              `cmd:${entry}/${cmdName}`,
              title || `Command: ${cmdName}`,
              description || `Command "${cmdName}" from plugin "${plugin.name}"`,
              content
            )
          }
        }
      }
    }

    // ── 3. MCP servers from .mcp.json ─────────────────────────
    const mcpJsonPath = join(pluginDir, '.mcp.json')
    if (existsSync(mcpJsonPath)) {
      try {
        const raw = readFileSync(mcpJsonPath, 'utf-8')
        const mcpConfig = JSON.parse(raw)

        // .mcp.json format: { "mcpServers": { "serverName": { "command": "...", "args": [...], "env": {...} } } }
        const servers = mcpConfig.mcpServers || mcpConfig

        if (typeof servers === 'object' && !Array.isArray(servers)) {
          for (const [serverName, serverConfig] of Object.entries(servers)) {
            const config = serverConfig as {
              command?: string
              args?: string[]
              env?: Record<string, string>
              environment?: Record<string, string>
              url?: string
              type?: 'local' | 'remote'
            }

            try {
              this.db.createMcpServer({
                name: `${plugin.name}:${serverName}`,
                type: config.type || (config.url ? 'remote' : 'local'),
                command: config.command || '',
                args: config.args || [],
                url: config.url,
                environment: config.env || config.environment || {}
              })
            } catch (err) {
              console.warn(`[ClaudePluginManager] Failed to create MCP server "${serverName}" from plugin:`, err)
            }
          }
        }
      } catch (err) {
        console.warn(`[ClaudePluginManager] Failed to parse .mcp.json for plugin "${plugin.name}":`, err)
      }
    }

    // ── 4. Agents from agents/ directory ────────────────────────
    // Collect all plugin skill IDs and MCP server IDs so agents auto-inherit them
    const allSkills = this.db.getSkills()
    const pluginSkillIds = allSkills
      .filter((s) => s.tags.includes('plugin') && s.tags.includes(plugin.name))
      .map((s) => s.id)

    const allMcpServers = this.db.getMcpServers()
    const pluginMcpServerIds = allMcpServers
      .filter((s) => s.name.startsWith(`${plugin.name}:`))
      .map((s) => s.id)

    const agentsDir = join(pluginDir, 'agents')
    if (existsSync(agentsDir)) {
      const entries = readdirSync(agentsDir)
      for (const entry of entries) {
        const entryPath = join(agentsDir, entry)
        const stat = statSync(entryPath)

        if (stat.isFile() && entry.endsWith('.md')) {
          const content = readFileSync(entryPath, 'utf-8')
          const agentName = basename(entry, '.md')
          const { title, description, model } = this.parseAgentFrontmatter(content, agentName)
          this.createPluginAgent(plugin.name, agentName, title, description, content, model, pluginSkillIds, pluginMcpServerIds)
        }
      }
    }

    // ── 6. Fallback: MCP servers from manifest ────────────────
    // If no .mcp.json was found, check the manifest for mcpServers
    const manifest = plugin.manifest
    if (!existsSync(mcpJsonPath) && manifest.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)) {
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
          console.warn(`[ClaudePluginManager] Failed to create MCP server from manifest:`, err)
        }
      }
    }

    // ── 7. Fallback: Skills from manifest (if no files found) ─
    const hasSkillFiles = existsSync(skillsDir) || existsSync(commandsDir)
    if (!hasSkillFiles && manifest.skills && Array.isArray(manifest.skills)) {
      for (const skillPath of manifest.skills) {
        try {
          this.db.createSkill({
            name: `${plugin.name}:${typeof skillPath === 'string' ? skillPath.replace(/\//g, '-').replace(/^-/, '') : 'skill'}`,
            description: `Skill from plugin "${plugin.name}"`,
            content: `Plugin skill: ${skillPath}`,
            tags: ['plugin', plugin.name]
          })
        } catch (err) {
          console.warn(`[ClaudePluginManager] Failed to create skill from manifest:`, err)
        }
      }
    }
  }

  /**
   * Creates a 20x skill record for a plugin skill or command.
   */
  private createPluginSkill(
    pluginName: string,
    skillKey: string,
    title: string,
    description: string,
    content: string
  ): void {
    try {
      this.db.createSkill({
        name: `${pluginName}:${skillKey}`,
        description: description || `Skill from plugin "${pluginName}"`,
        content,
        tags: ['plugin', pluginName]
      })
    } catch (err) {
      console.warn(`[ClaudePluginManager] Failed to create skill "${skillKey}" from plugin "${pluginName}":`, err)
    }
  }

  /**
   * Creates a 20x agent record for a plugin agent.
   * Agent frontmatter format: name, description, model
   */
  private createPluginAgent(
    pluginName: string,
    agentKey: string,
    title: string,
    description: string,
    content: string,
    model?: string,
    skillIds?: string[],
    mcpServerIds?: string[]
  ): void {
    try {
      // Strip frontmatter from content to use as system prompt
      const systemPrompt = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim()

      this.db.createAgent({
        name: `${pluginName}:${agentKey}`,
        config: {
          system_prompt: systemPrompt,
          model: model || undefined,
          skill_ids: skillIds?.length ? skillIds : undefined,
          mcp_servers: mcpServerIds?.length ? mcpServerIds : undefined
        }
      })
    } catch (err) {
      console.warn(`[ClaudePluginManager] Failed to create agent "${agentKey}" from plugin "${pluginName}":`, err)
    }
  }

  /**
   * Parses frontmatter from an agent markdown file.
   * Agent frontmatter fields: name, description, model
   */
  private parseAgentFrontmatter(
    content: string,
    fallbackName: string
  ): { title: string; description: string; model?: string } {
    let title = fallbackName
    let description = ''
    let model: string | undefined

    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (fmMatch) {
      const fm = fmMatch[1]
      const nameMatch = fm.match(/^name:\s*(.+)$/m)
      const descMatch = fm.match(/^description:\s*(.+)$/m)
      const modelMatch = fm.match(/^model:\s*(.+)$/m)
      if (nameMatch) title = nameMatch[1].replace(/^["']|["']$/g, '').trim()
      if (descMatch) description = descMatch[1].replace(/^["']|["']$/g, '').trim()
      if (modelMatch) model = modelMatch[1].replace(/^["']|["']$/g, '').trim()
    }

    // Fallback: first # heading
    if (title === fallbackName) {
      const headingMatch = content.match(/^#\s+(.+)$/m)
      if (headingMatch) title = headingMatch[1].trim()
    }

    return { title, description, model }
  }

  /**
   * Parses YAML-like frontmatter from a markdown file.
   * Extracts title and description from frontmatter block (--- ... ---) or
   * falls back to the first heading and paragraph.
   */
  private parseMarkdownFrontmatter(
    content: string,
    fallbackName: string
  ): { title: string; description: string } {
    let title = fallbackName
    let description = ''

    // Try YAML frontmatter
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (fmMatch) {
      const fm = fmMatch[1]
      const titleMatch = fm.match(/^title:\s*(.+)$/m)
      const descMatch = fm.match(/^description:\s*(.+)$/m)
      if (titleMatch) title = titleMatch[1].replace(/^["']|["']$/g, '').trim()
      if (descMatch) description = descMatch[1].replace(/^["']|["']$/g, '').trim()
    }

    // Fallback: first # heading
    if (title === fallbackName) {
      const headingMatch = content.match(/^#\s+(.+)$/m)
      if (headingMatch) title = headingMatch[1].trim()
    }

    // Fallback: first non-empty, non-heading line as description
    if (!description) {
      const lines = content.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
          description = trimmed.slice(0, 200)
          break
        }
      }
    }

    return { title, description }
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

    // Remove agents created by this plugin
    const agents = this.db.getAgents()
    const pluginAgents = agents.filter((a) => a.name.startsWith(`${plugin.name}:`))
    for (const agent of pluginAgents) {
      this.db.deleteAgent(agent.id)
    }
  }

  /**
   * Removes the downloaded plugin files directory.
   */
  private async cleanupPluginFiles(pluginName: string): Promise<void> {
    const { join } = await import('path')
    const { existsSync, rmSync } = await import('fs')

    const pluginDir = join(this.pluginsDir, pluginName)
    if (existsSync(pluginDir)) {
      try {
        rmSync(pluginDir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`[ClaudePluginManager] Failed to clean up plugin files for "${pluginName}":`, err)
      }
    }
  }
}
