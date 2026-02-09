import { describe, it, expect } from 'vitest'
import { PluginRegistry } from './registry'
import type { TaskSourcePlugin } from './types'

function makePlugin(id: string): TaskSourcePlugin {
  return {
    id,
    displayName: `Plugin ${id}`,
    description: `Description for ${id}`,
    icon: 'Zap',
    requiresMcpServer: true,
    getConfigSchema: () => [],
    resolveOptions: async () => [],
    validateConfig: () => null,
    getFieldMapping: () => ({ external_id: 'id', title: 'name' }),
    getActions: () => [],
    importTasks: async () => ({ imported: 0, updated: 0, errors: [] }),
    exportUpdate: async () => {},
    executeAction: async () => ({ success: true })
  }
}

describe('PluginRegistry', () => {
  it('registers and retrieves a plugin', () => {
    const registry = new PluginRegistry()
    const plugin = makePlugin('test')
    registry.register(plugin)
    expect(registry.get('test')).toBe(plugin)
  })

  it('returns undefined for unknown plugin', () => {
    const registry = new PluginRegistry()
    expect(registry.get('unknown')).toBeUndefined()
  })

  it('lists all registered plugins', () => {
    const registry = new PluginRegistry()
    registry.register(makePlugin('a'))
    registry.register(makePlugin('b'))
    const list = registry.list()
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({
      id: 'a',
      displayName: 'Plugin a',
      description: 'Description for a',
      icon: 'Zap',
      requiresMcpServer: true
    })
  })

  it('overwrites plugin with same id', () => {
    const registry = new PluginRegistry()
    registry.register(makePlugin('x'))
    const updated = makePlugin('x')
    updated.displayName = 'Updated'
    registry.register(updated)
    expect(registry.get('x')!.displayName).toBe('Updated')
    expect(registry.list()).toHaveLength(1)
  })

  it('lists empty when no plugins registered', () => {
    const registry = new PluginRegistry()
    expect(registry.list()).toEqual([])
  })
})
