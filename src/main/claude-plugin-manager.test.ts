import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager } from './database'
import { ClaudePluginManager } from './claude-plugin-manager'

let db: DatabaseManager
let manager: ClaudePluginManager

beforeEach(() => {
  ;({ db } = createTestDb())
  manager = new ClaudePluginManager(db)
})

describe('Marketplace Sources CRUD', () => {
  it('adds a marketplace source', () => {
    const source = manager.addMarketplaceSource({
      name: 'test-marketplace',
      source_type: 'github',
      source_url: 'owner/repo'
    })
    expect(source).toBeDefined()
    expect(source.name).toBe('test-marketplace')
    expect(source.source_type).toBe('github')
    expect(source.source_url).toBe('owner/repo')
  })

  it('prevents duplicate marketplace names', () => {
    manager.addMarketplaceSource({
      name: 'test-marketplace',
      source_url: 'owner/repo'
    })
    expect(() =>
      manager.addMarketplaceSource({
        name: 'test-marketplace',
        source_url: 'other/repo'
      })
    ).toThrow('already exists')
  })

  it('lists marketplace sources', () => {
    manager.addMarketplaceSource({ name: 'mp1', source_url: 'owner/repo1' })
    manager.addMarketplaceSource({ name: 'mp2', source_url: 'owner/repo2' })
    const sources = manager.getMarketplaceSources()
    expect(sources).toHaveLength(2)
  })

  it('removes a marketplace source', () => {
    const source = manager.addMarketplaceSource({ name: 'mp1', source_url: 'owner/repo' })
    expect(manager.removeMarketplaceSource(source.id)).toBe(true)
    expect(manager.getMarketplaceSources()).toHaveLength(0)
  })
})

describe('Database: Marketplace Sources', () => {
  it('creates and retrieves a marketplace source', () => {
    const source = db.createMarketplaceSource({
      name: 'my-marketplace',
      source_type: 'github',
      source_url: 'anthropics/claude-code'
    })
    expect(source.id).toBeTruthy()
    expect(source.name).toBe('my-marketplace')
    expect(source.auto_update).toBe(false)

    const fetched = db.getMarketplaceSource(source.id)
    expect(fetched).toEqual(source)
  })

  it('finds marketplace source by name', () => {
    db.createMarketplaceSource({ name: 'test-mp', source_url: 'owner/repo' })
    const found = db.getMarketplaceSourceByName('test-mp')
    expect(found).toBeDefined()
    expect(found!.name).toBe('test-mp')
  })

  it('updates a marketplace source', () => {
    const source = db.createMarketplaceSource({ name: 'mp', source_url: 'owner/repo' })
    const updated = db.updateMarketplaceSource(source.id, { auto_update: true, metadata: { version: '2.0' } })
    expect(updated!.auto_update).toBe(true)
    expect(updated!.metadata).toEqual({ version: '2.0' })
  })

  it('deletes a marketplace source', () => {
    const source = db.createMarketplaceSource({ name: 'mp', source_url: 'owner/repo' })
    expect(db.deleteMarketplaceSource(source.id)).toBe(true)
    expect(db.getMarketplaceSource(source.id)).toBeUndefined()
  })
})

describe('Database: Installed Plugins', () => {
  let marketplaceId: string

  beforeEach(() => {
    const source = db.createMarketplaceSource({ name: 'test-mp', source_url: 'owner/repo' })
    marketplaceId = source.id
  })

  it('creates and retrieves an installed plugin', () => {
    const plugin = db.createInstalledPlugin({
      name: 'my-plugin',
      marketplace_id: marketplaceId,
      manifest: { name: 'my-plugin', description: 'Test plugin', version: '1.0.0' },
      source: { source: 'github', repo: 'owner/my-plugin' },
      version: '1.0.0'
    })
    expect(plugin.id).toBeTruthy()
    expect(plugin.name).toBe('my-plugin')
    expect(plugin.enabled).toBe(true)
    expect(plugin.manifest.description).toBe('Test plugin')
    expect(plugin.source.repo).toBe('owner/my-plugin')

    const fetched = db.getInstalledPlugin(plugin.id)
    expect(fetched).toEqual(plugin)
  })

  it('lists all installed plugins', () => {
    db.createInstalledPlugin({ name: 'plugin-1', marketplace_id: marketplaceId })
    db.createInstalledPlugin({ name: 'plugin-2', marketplace_id: marketplaceId })
    const plugins = db.getInstalledPlugins()
    expect(plugins).toHaveLength(2)
  })

  it('finds plugin by name and marketplace', () => {
    db.createInstalledPlugin({ name: 'find-me', marketplace_id: marketplaceId })
    const found = db.getInstalledPluginByName('find-me', marketplaceId)
    expect(found).toBeDefined()
    expect(found!.name).toBe('find-me')
  })

  it('updates an installed plugin', () => {
    const plugin = db.createInstalledPlugin({ name: 'updatable', marketplace_id: marketplaceId })
    const updated = db.updateInstalledPlugin(plugin.id, { enabled: false, version: '2.0.0' })
    expect(updated!.enabled).toBe(false)
    expect(updated!.version).toBe('2.0.0')
  })

  it('deletes an installed plugin', () => {
    const plugin = db.createInstalledPlugin({ name: 'deletable', marketplace_id: marketplaceId })
    expect(db.deleteInstalledPlugin(plugin.id)).toBe(true)
    expect(db.getInstalledPlugin(plugin.id)).toBeUndefined()
  })

  it('cascades delete when marketplace is removed', () => {
    db.createInstalledPlugin({ name: 'cascade-me', marketplace_id: marketplaceId })
    expect(db.getInstalledPlugins()).toHaveLength(1)
    db.deleteMarketplaceSource(marketplaceId)
    expect(db.getInstalledPlugins()).toHaveLength(0)
  })
})

describe('ClaudePluginManager: Install / Uninstall', () => {
  let marketplaceId: string

  beforeEach(() => {
    const source = manager.addMarketplaceSource({ name: 'test-mp', source_url: 'owner/repo' })
    marketplaceId = source.id

    // Manually set the catalog cache via fetchMarketplaceCatalog's internal path
    // We'll use a workaround: directly populate the cache through the manager's internal state
    // by calling discoverPlugins after setting up the catalog
    ;(manager as unknown as { catalogCache: Map<string, unknown> }).catalogCache.set(marketplaceId, {
      name: 'test-mp',
      owner: { name: 'Test' },
      plugins: [
        {
          name: 'cool-plugin',
          source: './plugins/cool-plugin',
          description: 'A cool plugin',
          version: '1.2.0',
          author: { name: 'Test Author' },
          category: 'testing',
          tags: ['test', 'cool']
        },
        {
          name: 'another-plugin',
          source: { source: 'github', repo: 'owner/another' },
          description: 'Another plugin',
          version: '0.5.0'
        }
      ]
    })
  })

  it('installs a plugin from the catalog', async () => {
    const installed = await manager.installPlugin('cool-plugin', marketplaceId)
    expect(installed.name).toBe('cool-plugin')
    expect(installed.version).toBe('1.2.0')
    expect(installed.enabled).toBe(true)
    expect(installed.manifest.description).toBe('A cool plugin')
  })

  it('prevents double installation', async () => {
    await manager.installPlugin('cool-plugin', marketplaceId)
    await expect(manager.installPlugin('cool-plugin', marketplaceId)).rejects.toThrow('already installed')
  })

  it('uninstalls a plugin', async () => {
    const installed = await manager.installPlugin('cool-plugin', marketplaceId)
    expect(manager.getInstalledPlugins()).toHaveLength(1)
    const result = await manager.uninstallPlugin(installed.id)
    expect(result).toBe(true)
    expect(manager.getInstalledPlugins()).toHaveLength(0)
  })

  it('enables and disables a plugin', async () => {
    const installed = await manager.installPlugin('cool-plugin', marketplaceId)
    expect(installed.enabled).toBe(true)

    const disabled = manager.disablePlugin(installed.id)
    expect(disabled!.enabled).toBe(false)

    const enabled = manager.enablePlugin(installed.id)
    expect(enabled!.enabled).toBe(true)
  })

  it('discovers plugins from catalog', async () => {
    const plugins = await manager.discoverPlugins()
    expect(plugins).toHaveLength(2)
    expect(plugins[0].name).toBe('cool-plugin')
    expect(plugins[0].installed).toBe(false)
    expect(plugins[1].name).toBe('another-plugin')
  })

  it('discovers with search filtering', async () => {
    const plugins = await manager.discoverPlugins('cool')
    expect(plugins).toHaveLength(1)
    expect(plugins[0].name).toBe('cool-plugin')
  })

  it('marks installed plugins in discover results', async () => {
    await manager.installPlugin('cool-plugin', marketplaceId)
    const plugins = await manager.discoverPlugins()
    const cool = plugins.find((p) => p.name === 'cool-plugin')
    expect(cool!.installed).toBe(true)
    expect(cool!.installed_plugin_id).toBeTruthy()
  })

  it('throws when plugin not found in catalog', async () => {
    await expect(manager.installPlugin('nonexistent', marketplaceId)).rejects.toThrow('not found')
  })

  it('throws when catalog not loaded', async () => {
    const source2 = manager.addMarketplaceSource({ name: 'empty-mp', source_url: 'x/y' })
    await expect(manager.installPlugin('any', source2.id)).rejects.toThrow('not loaded')
  })
})
