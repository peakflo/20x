import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { getPluginForm } from '@/components/plugins'
import { PluginSetupDocumentation } from '@/components/plugins/PluginSetupDocumentation'
import { pluginApi } from '@/lib/ipc-client'
import type { McpServer, TaskSource, CreateTaskSourceDTO, PluginMeta } from '@/types'

interface TaskSourceFormDialogProps {
  source?: TaskSource
  mcpServers: McpServer[]
  plugins: PluginMeta[]
  open: boolean
  onClose: () => void
  onSubmit: (data: CreateTaskSourceDTO) => void
}

export function TaskSourceFormDialog({
  source,
  mcpServers,
  plugins,
  open,
  onClose,
  onSubmit
}: TaskSourceFormDialogProps) {
  const [name, setName] = useState(source?.name ?? '')
  const [pluginId, setPluginId] = useState(source?.plugin_id ?? (plugins[0]?.id ?? 'peakflo'))
  const [mcpServerId, setMcpServerId] = useState(source?.mcp_server_id ?? (mcpServers[0]?.id ?? ''))
  const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>(source?.config ?? {})
  const [documentation, setDocumentation] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName(source?.name ?? '')
      setPluginId(source?.plugin_id ?? (plugins[0]?.id ?? 'peakflo'))
      setMcpServerId(source?.mcp_server_id ?? (mcpServers[0]?.id ?? ''))
      setPluginConfig(source?.config ?? {})
    }
  }, [open, source?.id])

  // Fetch documentation when plugin changes
  useEffect(() => {
    if (pluginId) {
      pluginApi.getDocumentation(pluginId).then(setDocumentation).catch(() => setDocumentation(null))
    }
  }, [pluginId])

  const selectedPlugin = plugins.find((p) => p.id === pluginId)
  const isValid = name.trim() && pluginId && (!selectedPlugin?.requiresMcpServer || mcpServerId)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid) return

    const data: CreateTaskSourceDTO = {
      mcp_server_id: selectedPlugin?.requiresMcpServer ? mcpServerId : null,
      name: name.trim(),
      plugin_id: pluginId,
      config: pluginConfig
    }

    onSubmit(data)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-6xl">
        <DialogHeader>
          <DialogTitle>{source ? 'Edit Task Source' : 'New Task Source'}</DialogTitle>
        </DialogHeader>
        <DialogBody className="p-0">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-0">
            {/* Left Column - Form */}
            <div className="p-6 border-r border-border">
              <form onSubmit={handleSubmit} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ts-plugin">Plugin</Label>
                  <select
                    id="ts-plugin"
                    value={pluginId}
                    onChange={(e) => {
                      setPluginId(e.target.value)
                      setPluginConfig({})
                    }}
                    className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
                  >
                    {plugins.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                      </option>
                    ))}
                  </select>
                  {selectedPlugin?.description && (
                    <p className="text-xs text-muted-foreground">{selectedPlugin.description}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="ts-name">Name</Label>
                  <Input
                    id="ts-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={selectedPlugin?.displayName ?? 'My Source'}
                    required
                  />
                </div>

                {selectedPlugin?.requiresMcpServer && (
                  <div className="space-y-1.5">
                    <Label htmlFor="ts-server">MCP Server</Label>
                    <select
                      id="ts-server"
                      value={mcpServerId}
                      onChange={(e) => setMcpServerId(e.target.value)}
                      className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
                      required
                    >
                      {mcpServers.length === 0 ? (
                        <option value="">No MCP servers available</option>
                      ) : (
                        mcpServers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                )}

                {selectedPlugin && (() => {
                  const PluginForm = getPluginForm(selectedPlugin.id)
                  if (!PluginForm) {
                    return (
                      <div className="text-sm text-muted-foreground py-4">
                        No configuration form available for this plugin.
                      </div>
                    )
                  }

                  return (
                    <PluginForm
                      value={pluginConfig}
                      onChange={setPluginConfig}
                      sourceId={source?.id}
                      onRequestSave={() => {
                        // Auto-save source before OAuth when creating new source
                        if (!source && isValid) {
                          const data: CreateTaskSourceDTO = {
                            mcp_server_id: selectedPlugin?.requiresMcpServer ? mcpServerId : null,
                            name: name.trim(),
                            plugin_id: pluginId,
                            config: pluginConfig
                          }
                          onSubmit(data)
                          return true
                        }
                        return false
                      }}
                    />
                  )
                })()}

                <div className="flex justify-end gap-2 pt-1">
                  <Button type="button" variant="outline" size="sm" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={!isValid}>
                    {source ? 'Save' : 'Add'}
                  </Button>
                </div>
              </form>
            </div>

            {/* Right Column - Documentation */}
            <div className="p-6 bg-muted/30 overflow-y-auto max-h-[70vh]">
              {documentation ? (
                <PluginSetupDocumentation markdown={documentation} />
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  No documentation available for this plugin.
                </div>
              )}
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
