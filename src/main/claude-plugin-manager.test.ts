import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager } from './database'
import { ClaudePluginManager } from './claude-plugin-manager'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let db: DatabaseManager
let manager: ClaudePluginManager
let tempPluginsDir: string

beforeEach(() => {
  ;({ db } = createTestDb())
  tempPluginsDir = mkdtempSync(join(tmpdir(), '20x-plugins-test-'))
  manager = new ClaudePluginManager(db, tempPluginsDir)

  // Mock global fetch to prevent actual network requests during tests
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status: 404,
    json: async () => ({}),
    text: async () => ''
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Default Marketplaces', () => {
  it('seeds two default Anthropic marketplaces on first run', () => {
    const sources = manager.getMarketplaceSources()
    expect(sources).toHaveLength(2)
    expect(sources.map((s) => s.name).sort()).toEqual(['anthropic-official', 'claude-code-plugins'])

    const official = sources.find((s) => s.name === 'anthropic-official')!
    expect(official.source_type).toBe('github')
    expect(official.source_url).toBe('anthropics/claude-plugins-official')

    const bundled = sources.find((s) => s.name === 'claude-code-plugins')!
    expect(bundled.source_type).toBe('github')
    expect(bundled.source_url).toBe('anthropics/claude-code')
  })

  it('does not re-seed defaults when sources already exist', () => {
    // manager already seeded 2 defaults
    expect(manager.getMarketplaceSources()).toHaveLength(2)

    // Creating a new manager instance should not duplicate
    const manager2 = new ClaudePluginManager(db, tempPluginsDir)
    expect(manager2.getMarketplaceSources()).toHaveLength(2)
  })
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

  it('lists marketplace sources including defaults', () => {
    manager.addMarketplaceSource({ name: 'mp1', source_url: 'owner/repo1' })
    manager.addMarketplaceSource({ name: 'mp2', source_url: 'owner/repo2' })
    const sources = manager.getMarketplaceSources()
    // 2 defaults + 2 new
    expect(sources).toHaveLength(4)
  })

  it('removes a marketplace source', () => {
    const source = manager.addMarketplaceSource({ name: 'mp1', source_url: 'owner/repo' })
    const countBefore = manager.getMarketplaceSources().length
    expect(manager.removeMarketplaceSource(source.id)).toBe(true)
    expect(manager.getMarketplaceSources()).toHaveLength(countBefore - 1)
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

describe('Plugin Resource Materialization from Files', () => {
  let marketplaceId: string

  beforeEach(() => {
    const source = manager.addMarketplaceSource({
      name: 'local-mp',
      source_type: 'local',
      source_url: tempPluginsDir
    })
    marketplaceId = source.id

    ;(manager as unknown as { catalogCache: Map<string, unknown> }).catalogCache.set(marketplaceId, {
      name: 'local-mp',
      owner: { name: 'Test' },
      plugins: [
        {
          name: 'file-plugin',
          source: './file-plugin',
          description: 'Plugin with files',
          version: '1.0.0'
        }
      ]
    })
  })

  function setupPluginFiles(): void {
    // fs imports from top-level
    const pluginDir = join(tempPluginsDir, 'file-plugin')
    mkdirSync(pluginDir, { recursive: true })

    // Create skills/my-skill/SKILL.md
    const skillDir = join(pluginDir, 'skills', 'my-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), `---
title: My Skill
description: A test skill from plugin
---

# My Skill

This skill does something useful.
`)

    // Create skills/another.md (direct .md file)
    writeFileSync(join(pluginDir, 'skills', 'another.md'), `# Another Skill

Direct skill file in skills directory.
`)

    // Create commands/build.md
    const cmdDir = join(pluginDir, 'commands')
    mkdirSync(cmdDir, { recursive: true })
    writeFileSync(join(cmdDir, 'build.md'), `---
title: Build Command
description: Runs the build process
---

# Build

Run \`npm run build\` in the project root.
`)

    // Create agents/verifier-py.md and agents/verifier-ts.md
    const agentsDir = join(pluginDir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, 'verifier-py.md'), `---
name: agent-sdk-verifier-py
description: Verify Python Agent SDK applications
model: sonnet
---

You are a Python Agent SDK application verifier. Your role is to inspect Python Agent SDK apps.
`)
    writeFileSync(join(agentsDir, 'verifier-ts.md'), `---
name: agent-sdk-verifier-ts
description: Verify TypeScript Agent SDK applications
model: sonnet
---

You are a TypeScript Agent SDK application verifier.
`)

    // Create .mcp.json
    writeFileSync(join(pluginDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'my-server': {
          command: 'node',
          args: ['server.js'],
          env: { PORT: '3000' }
        },
        'another-server': {
          command: 'python',
          args: ['-m', 'mcp_server'],
          env: { DEBUG: 'true' }
        }
      }
    }))
  }

  it('creates 20x skills from skills/ directory SKILL.md files', async () => {
    setupPluginFiles()
    await manager.installPlugin('file-plugin', marketplaceId)

    const resources = manager.getPluginResources(
      manager.getInstalledPlugins().find((p) => p.name === 'file-plugin')!.id
    )

    const skillNames = resources.skills.map((s) => s.name)
    expect(skillNames).toContain('file-plugin:my-skill')
    const mySkill = resources.skills.find((s) => s.name === 'file-plugin:my-skill')!
    expect(mySkill.description).toBe('A test skill from plugin')
  })

  it('creates 20x skills from direct .md files in skills/', async () => {
    setupPluginFiles()
    await manager.installPlugin('file-plugin', marketplaceId)

    const resources = manager.getPluginResources(
      manager.getInstalledPlugins().find((p) => p.name === 'file-plugin')!.id
    )

    const skillNames = resources.skills.map((s) => s.name)
    expect(skillNames).toContain('file-plugin:another')
  })

  it('creates 20x skills from commands/ directory (commands are skills)', async () => {
    setupPluginFiles()
    await manager.installPlugin('file-plugin', marketplaceId)

    const resources = manager.getPluginResources(
      manager.getInstalledPlugins().find((p) => p.name === 'file-plugin')!.id
    )

    const skillNames = resources.skills.map((s) => s.name)
    expect(skillNames).toContain('file-plugin:cmd:build')
    const buildCmd = resources.skills.find((s) => s.name === 'file-plugin:cmd:build')!
    expect(buildCmd.description).toBe('Runs the build process')
  })

  it('creates 20x MCP servers from .mcp.json', async () => {
    setupPluginFiles()
    await manager.installPlugin('file-plugin', marketplaceId)

    const resources = manager.getPluginResources(
      manager.getInstalledPlugins().find((p) => p.name === 'file-plugin')!.id
    )

    expect(resources.mcpServers).toHaveLength(2)
    const serverNames = resources.mcpServers.map((s) => s.name)
    expect(serverNames).toContain('file-plugin:my-server')
    expect(serverNames).toContain('file-plugin:another-server')

    const myServer = resources.mcpServers.find((s) => s.name === 'file-plugin:my-server')!
    expect(myServer.command).toBe('node')
    expect(myServer.args).toEqual(['server.js'])
  })

  it('creates 20x agents from agents/ directory', async () => {
    setupPluginFiles()
    await manager.installPlugin('file-plugin', marketplaceId)

    const resources = manager.getPluginResources(
      manager.getInstalledPlugins().find((p) => p.name === 'file-plugin')!.id
    )

    expect(resources.agents).toHaveLength(2)
    const agentNames = resources.agents.map((a) => a.name)
    expect(agentNames).toContain('file-plugin:verifier-py')
    expect(agentNames).toContain('file-plugin:verifier-ts')
  })

  it('agents are visible in the global agents list with skills auto-assigned', async () => {
    setupPluginFiles()
    await manager.installPlugin('file-plugin', marketplaceId)

    const allAgents = db.getAgents()
    const pluginAgents = allAgents.filter((a) => a.name.startsWith('file-plugin:'))
    expect(pluginAgents).toHaveLength(2)

    // Verify system_prompt is set (frontmatter stripped)
    const pyAgent = pluginAgents.find((a) => a.name === 'file-plugin:verifier-py')!
    expect(pyAgent.config.system_prompt).toContain('Python Agent SDK application verifier')
    // Frontmatter should be stripped from system_prompt
    expect(pyAgent.config.system_prompt).not.toContain('---')

    // Verify plugin skills are auto-assigned to agent
    const allSkills = db.getSkills()
    const pluginSkillIds = allSkills
      .filter((s) => s.tags.includes('plugin') && s.tags.includes('file-plugin'))
      .map((s) => s.id)
    expect(pluginSkillIds.length).toBeGreaterThan(0)
    expect(pyAgent.config.skill_ids).toEqual(pluginSkillIds)

    // Verify plugin MCP servers are auto-assigned to agent
    const allMcp = db.getMcpServers()
    const pluginMcpIds = allMcp
      .filter((s) => s.name.startsWith('file-plugin:'))
      .map((s) => s.id)
    expect(pluginMcpIds.length).toBeGreaterThan(0)
    expect(pyAgent.config.mcp_servers).toEqual(pluginMcpIds)
  })

  it('removes all resources on uninstall', async () => {
    setupPluginFiles()
    const installed = await manager.installPlugin('file-plugin', marketplaceId)

    // Verify resources exist
    const resources = manager.getPluginResources(installed.id)
    expect(resources.skills.length).toBeGreaterThan(0)
    expect(resources.mcpServers.length).toBeGreaterThan(0)
    expect(resources.agents.length).toBeGreaterThan(0)

    // Uninstall
    await manager.uninstallPlugin(installed.id)

    // Verify skills and MCP servers are cleaned up from DB
    const allSkills = db.getSkills()
    const pluginSkills = allSkills.filter((s) => s.tags.includes('plugin') && s.tags.includes('file-plugin'))
    expect(pluginSkills).toHaveLength(0)

    const allMcp = db.getMcpServers()
    const pluginMcp = allMcp.filter((s) => s.name.startsWith('file-plugin:'))
    expect(pluginMcp).toHaveLength(0)

    // Verify agents are cleaned up from DB
    const allAgents = db.getAgents()
    const pluginAgents = allAgents.filter((a) => a.name.startsWith('file-plugin:'))
    expect(pluginAgents).toHaveLength(0)
  })

  it('cleans up downloaded plugin files on uninstall', async () => {
    setupPluginFiles()
    const installed = await manager.installPlugin('file-plugin', marketplaceId)

    // fs imports from top-level
    const pluginDir = join(tempPluginsDir, 'file-plugin')
    expect(existsSync(pluginDir)).toBe(true)

    await manager.uninstallPlugin(installed.id)
    expect(existsSync(pluginDir)).toBe(false)
  })
})
