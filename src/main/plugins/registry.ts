import type { TaskSourcePlugin } from './types'

export interface PluginMeta {
  id: string
  displayName: string
  description: string
  icon: string
  requiresMcpServer: boolean
}

export class PluginRegistry {
  private plugins = new Map<string, TaskSourcePlugin>()

  register(plugin: TaskSourcePlugin): void {
    this.plugins.set(plugin.id, plugin)
  }

  get(id: string): TaskSourcePlugin | undefined {
    return this.plugins.get(id)
  }

  list(): PluginMeta[] {
    return Array.from(this.plugins.values()).map((p) => ({
      id: p.id,
      displayName: p.displayName,
      description: p.description,
      icon: p.icon,
      requiresMcpServer: p.requiresMcpServer
    }))
  }
}
