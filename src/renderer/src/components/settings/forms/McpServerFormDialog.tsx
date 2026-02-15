import { useState, useEffect } from 'react'
import { Server, Globe } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { KeyValueEditor } from '../KeyValueEditor'
import { shellQuoteArg, parseShellArgs } from '../utils'
import type { McpServer, CreateMcpServerDTO } from '@/types'

interface McpServerFormDialogProps {
  server?: McpServer
  open: boolean
  onClose: () => void
  onSubmit: (data: CreateMcpServerDTO) => void
}

export function McpServerFormDialog({ server, open, onClose, onSubmit }: McpServerFormDialogProps) {
  const [name, setName] = useState(server?.name ?? '')
  const [type, setType] = useState<'local' | 'remote'>(server?.type ?? 'local')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState(server?.args.map(shellQuoteArg).join(' ') ?? '')
  const [environment, setEnvironment] = useState<Record<string, string>>(server?.environment ?? {})
  const [url, setUrl] = useState(server?.url ?? '')
  const [headers, setHeaders] = useState<Record<string, string>>(server?.headers ?? {})

  useEffect(() => {
    if (open) {
      setName(server?.name ?? '')
      setType(server?.type ?? 'local')
      setCommand(server?.command ?? '')
      setArgs(server?.args.map(shellQuoteArg).join(' ') ?? '')
      setEnvironment(server?.environment ?? {})
      setUrl(server?.url ?? '')
      setHeaders(server?.headers ?? {})
    }
  }, [open, server?.id])

  const isValid = name.trim() && (type === 'local' ? command.trim() : url.trim())

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid) return

    const data: CreateMcpServerDTO = { name: name.trim(), type }
    if (type === 'local') {
      data.command = command.trim()
      data.args = args.trim() ? parseShellArgs(args.trim()) : []
      if (Object.keys(environment).length > 0) data.environment = environment
    } else {
      data.url = url.trim()
      if (Object.keys(headers).length > 0) data.headers = headers
    }

    onSubmit(data)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{server ? 'Edit MCP Server' : 'New MCP Server'}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="filesystem"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>Type</Label>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant={type === 'local' ? 'default' : 'outline'}
                  onClick={() => setType('local')}
                  className="flex-1"
                >
                  <Server className="h-3.5 w-3.5 mr-1.5" /> Local
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={type === 'remote' ? 'default' : 'outline'}
                  onClick={() => setType('remote')}
                  className="flex-1"
                >
                  <Globe className="h-3.5 w-3.5 mr-1.5" /> Remote
                </Button>
              </div>
            </div>

            {type === 'local' ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-command">Command</Label>
                  <Input
                    id="mcp-command"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="npx"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-args">Arguments</Label>
                  <Input
                    id="mcp-args"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder='mcp-remote https://url --header "Authorization: Bearer token"'
                  />
                </div>
                <KeyValueEditor
                  label="Environment Variables"
                  value={environment}
                  onChange={setEnvironment}
                  keyPlaceholder="VAR_NAME"
                  valuePlaceholder="value"
                />
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-url">URL</Label>
                  <Input
                    id="mcp-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://mcp.example.com/sse"
                    required
                  />
                </div>
                <KeyValueEditor
                  label="Headers"
                  value={headers}
                  onChange={setHeaders}
                  keyPlaceholder="Header-Name"
                  valuePlaceholder="value"
                />
              </>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!isValid}>
                {server ? 'Save' : 'Add'}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
