import { useState, useEffect, useRef, useCallback } from 'react'
import { Server, Globe, Loader2, KeyRound, LogOut } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { KeyValueEditor } from '../KeyValueEditor'
import { shellQuoteArg, parseShellArgs } from '../utils'
import type { McpServer, CreateMcpServerDTO } from '@/types'

interface OAuthCallbacks {
  probeForAuth: (url: string) => Promise<boolean>
  startOAuthFlow: (serverId: string) => Promise<{ needsManualClientId?: boolean }>
  submitManualClientId: (serverId: string, clientId: string) => Promise<{ needsManualClientId?: boolean }>
  revokeOAuthToken: (serverId: string) => Promise<void>
}

interface McpServerFormDialogProps {
  server?: McpServer
  open: boolean
  onClose: () => void
  onSubmit: (data: CreateMcpServerDTO) => void
  oauthConnected?: boolean
  oauth: OAuthCallbacks
}

export function McpServerFormDialog({ server, open, onClose, onSubmit, oauthConnected, oauth }: McpServerFormDialogProps) {
  const [name, setName] = useState(server?.name ?? '')
  const [type, setType] = useState<'local' | 'remote'>(server?.type ?? 'local')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState(server?.args.map(shellQuoteArg).join(' ') ?? '')
  const [environment, setEnvironment] = useState<Record<string, string>>(server?.environment ?? {})
  const [url, setUrl] = useState(server?.url ?? '')
  const [headers, setHeaders] = useState<Record<string, string>>(server?.headers ?? {})

  // OAuth state
  const [probing, setProbing] = useState(false)
  const [authNeeded, setAuthNeeded] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [manualClientIdNeeded, setManualClientIdNeeded] = useState(false)
  const [manualClientId, setManualClientId] = useState('')
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (open) {
      setName(server?.name ?? '')
      setType(server?.type ?? 'local')
      setCommand(server?.command ?? '')
      setArgs(server?.args.map(shellQuoteArg).join(' ') ?? '')
      setEnvironment(server?.environment ?? {})
      setUrl(server?.url ?? '')
      setHeaders(server?.headers ?? {})
      setProbing(false)
      setAuthNeeded(false)
      setConnecting(false)
      setManualClientIdNeeded(false)
      setManualClientId('')
      // For edit mode: if already has OAuth registration, show it immediately
      if (server?.type === 'remote' && server.oauth_metadata && 'resource_url' in server.oauth_metadata) {
        setAuthNeeded(true)
      }
      // For edit mode: if remote server with URL but no stored OAuth metadata, probe live
      else if (server?.type === 'remote' && server.url?.trim() && !oauthConnected) {
        setProbing(true)
        oauth.probeForAuth(server.url.trim()).then((needed) => {
          setAuthNeeded(needed)
        }).catch(() => {
          setAuthNeeded(false)
        }).finally(() => {
          setProbing(false)
        })
      }
    }
    return () => {
      if (probeTimer.current) clearTimeout(probeTimer.current)
    }
  }, [open, server?.id])

  // Debounced probe when URL changes (only for remote type, only valid URLs)
  const handleUrlChange = useCallback((newUrl: string) => {
    setUrl(newUrl)
    if (probeTimer.current) clearTimeout(probeTimer.current)

    // Don't probe if editing an already-connected server (no need to re-probe)
    if (server && oauthConnected) return

    const trimmed = newUrl.trim()
    if (!trimmed || !trimmed.startsWith('http')) {
      setAuthNeeded(false)
      return
    }

    setProbing(true)
    probeTimer.current = setTimeout(async () => {
      try {
        const needed = await oauth.probeForAuth(trimmed)
        setAuthNeeded(needed)
      } catch {
        setAuthNeeded(false)
      } finally {
        setProbing(false)
      }
    }, 800)
  }, [server, oauthConnected, oauth])

  const isValid = name.trim() && (type === 'local' ? command.trim() : url.trim())

  const handleConnectOAuth = async () => {
    if (!server) return
    setConnecting(true)
    try {
      const result = await oauth.startOAuthFlow(server.id)
      if (result.needsManualClientId) {
        setManualClientIdNeeded(true)
        setManualClientId('')
      }
    } finally {
      setConnecting(false)
    }
  }

  const handleSubmitManualClientId = async () => {
    if (!server || !manualClientId.trim()) return
    setConnecting(true)
    try {
      const result = await oauth.submitManualClientId(server.id, manualClientId.trim())
      if (!result.needsManualClientId) {
        setManualClientIdNeeded(false)
        setManualClientId('')
      }
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnectOAuth = async () => {
    if (!server) return
    await oauth.revokeOAuthToken(server.id)
  }

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

  // Show OAuth section for remote servers when auth is needed or already connected
  const showOAuthSection = type === 'remote' && (authNeeded || oauthConnected)

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
                    onChange={(e) => handleUrlChange(e.target.value)}
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

            {/* OAuth section — shown for remote servers that need auth */}
            {showOAuthSection && (
              <div className={`rounded-md border px-3 py-2.5 space-y-2 ${
                oauthConnected
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-amber-500/30 bg-amber-500/5'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs">
                    {probing ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                        <span className="text-muted-foreground">Checking authentication...</span>
                      </>
                    ) : oauthConnected ? (
                      <>
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                        <KeyRound className="h-3 w-3 text-emerald-400" />
                        <span className="text-emerald-400">OAuth Connected</span>
                      </>
                    ) : (
                      <>
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
                        <KeyRound className="h-3 w-3 text-amber-400" />
                        <span className="text-amber-400">OAuth Required</span>
                      </>
                    )}
                  </div>
                  {server && oauthConnected && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                      onClick={handleDisconnectOAuth}
                    >
                      <LogOut className="h-3 w-3 mr-1" />
                      Disconnect
                    </Button>
                  )}
                  {server && !oauthConnected && !manualClientIdNeeded && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={handleConnectOAuth}
                      disabled={connecting}
                    >
                      {connecting ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <KeyRound className="h-3 w-3 mr-1" />
                      )}
                      Connect
                    </Button>
                  )}
                </div>
                {manualClientIdNeeded && (
                  <div className="flex items-center gap-2">
                    <Input
                      value={manualClientId}
                      onChange={(e) => setManualClientId(e.target.value)}
                      placeholder="Enter Client ID (from server provider)"
                      className="h-7 text-xs flex-1"
                    />
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 px-3 text-xs"
                      disabled={!manualClientId.trim() || connecting}
                      onClick={handleSubmitManualClientId}
                    >
                      {connecting ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Submit'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => { setManualClientIdNeeded(false); setManualClientId('') }}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
                {!server && !oauthConnected && !probing && (
                  <p className="text-[11px] text-muted-foreground">
                    OAuth will start automatically after adding the server.
                  </p>
                )}
              </div>
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
