import { useEffect, useState, useRef, useCallback } from 'react'
import { Check, Download, Loader2, Terminal, RefreshCw, X, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogTitle,
  DialogDescription
} from '@/components/ui/Dialog'

interface AgentStatus {
  installed: boolean
  version: string | null
}

type StatusMap = Record<string, AgentStatus>

interface ProgressEvent {
  agentName: string
  stage: string
  output: string
  percent: number
}

const TOOL_META: Record<string, { label: string; color: string; letter: string; required?: boolean; description: string; category: 'prerequisite' | 'agent' | 'tool' }> = {
  nodejs: { label: 'Node.js', color: 'bg-green-600', letter: 'N', required: true, description: 'JavaScript runtime (required for all agents)', category: 'prerequisite' },
  npm: { label: 'npm', color: 'bg-red-600', letter: 'n', required: true, description: 'Package manager (included with Node.js)', category: 'prerequisite' },
  git: { label: 'Git', color: 'bg-orange-600', letter: 'G', description: 'Version control system', category: 'prerequisite' },
  gh: { label: 'GitHub CLI', color: 'bg-gray-600', letter: 'gh', description: 'GitHub command-line tool', category: 'tool' },
  claudeCode: { label: 'Claude Code', color: 'bg-amber-600', letter: 'C', description: 'Anthropic\'s coding agent', category: 'agent' },
  opencode: { label: 'OpenCode', color: 'bg-blue-600', letter: 'O', description: 'Open-source coding agent (free models)', category: 'agent' },
  codex: { label: 'Codex', color: 'bg-purple-600', letter: 'X', description: 'OpenAI\'s coding agent', category: 'agent' }
}

// All tools are now installable
const INSTALLABLE = ['nodejs', 'npm', 'git', 'gh', 'claudeCode', 'opencode', 'codex', 'pnpm']

// Install order: prerequisites first, then tools, then agents
const INSTALL_ORDER = ['nodejs', 'git', 'gh', 'claudeCode', 'opencode', 'codex']

/** @deprecated Use `ToolSetupDialog` instead */
export const AgentSetupDialog = ToolSetupDialog

export function ToolSetupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [status, setStatus] = useState<StatusMap | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [terminalOutput, setTerminalOutput] = useState('')
  const [loading, setLoading] = useState(true)
  const termRef = useRef<HTMLDivElement>(null)

  const detect = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.agentInstaller.detect()
      setStatus(result)
    } catch (err) {
      console.error('Failed to detect agents:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Detect on open
  useEffect(() => {
    if (open) {
      detect()
      setTerminalOutput('')
    }
  }, [open, detect])

  // Listen for install progress
  useEffect(() => {
    if (!open) return
    const cleanup = window.electronAPI.agentInstaller.onProgress((data: ProgressEvent) => {
      setTerminalOutput((prev) => prev + data.output)
      if (data.stage === 'complete' || data.stage === 'error') {
        setInstalling(null)
        detect()
      }
    })
    return cleanup
  }, [open, detect])

  // Auto-scroll terminal
  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight
    }
  }, [terminalOutput])

  const handleInstall = async (agentName: string) => {
    setInstalling(agentName)
    setTerminalOutput((prev) => prev + `\n── Installing ${TOOL_META[agentName]?.label || agentName} ──\n`)
    try {
      await window.electronAPI.agentInstaller.install(agentName)
    } catch (err) {
      setTerminalOutput((prev) => prev + `Error: ${err}\n`)
      setInstalling(null)
    }
  }

  const handleInstallAll = async () => {
    if (!status) return

    // Install in correct order: prerequisites first
    const missing = INSTALL_ORDER.filter((key) => {
      const s = status[key]
      return s && !s.installed
    })

    for (const agentName of missing) {
      // Re-detect after each install to pick up newly available tools
      const freshStatus = await window.electronAPI.agentInstaller.detect()
      setStatus(freshStatus)

      // Skip if now installed (e.g. npm comes with nodejs)
      if (freshStatus[agentName]?.installed) continue

      setInstalling(agentName)
      setTerminalOutput((prev) => prev + `\n── Installing ${TOOL_META[agentName]?.label || agentName} ──\n`)
      try {
        await window.electronAPI.agentInstaller.install(agentName)
      } catch (err) {
        setTerminalOutput((prev) => prev + `Error: ${err}\n`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    setInstalling(null)
    await detect()
  }

  const missingCount = status
    ? INSTALL_ORDER.filter((key) => {
        const s = status[key]
        return s && !s.installed
      }).length
    : 0

  const installedCount = status
    ? Object.values(status).filter((v) => v.installed).length
    : 0

  const totalCount = status ? Object.keys(status).length : 0

  const hasPrerequisites = status?.nodejs?.installed && status?.npm?.installed

  const renderCategory = (category: 'prerequisite' | 'agent' | 'tool', title: string) => {
    const items = Object.entries(TOOL_META).filter(([, meta]) => meta.category === category)
    if (items.length === 0) return null

    return (
      <div className="mb-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5 px-1">{title}</p>
        <div className="grid gap-1.5">
          {items.map(([key, meta]) => {
            const toolStatus = status?.[key]
            if (!toolStatus) return null
            const isInstalling = installing === key
            const canInstall = INSTALLABLE.includes(key)
            // npm installs need Node.js first (except nodejs and git themselves)
            const needsPrereq = !hasPrerequisites && meta.category === 'agent' && !toolStatus.installed

            return (
              <div
                key={key}
                className={`flex items-center gap-3 rounded-lg border border-border p-2.5 bg-background ${needsPrereq ? 'opacity-60' : ''}`}
              >
                <div className={`${meta.color} rounded-full size-8 flex items-center justify-center text-white text-xs font-bold shrink-0`}>
                  {meta.letter}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground leading-tight">
                    {meta.label}
                    {meta.required && <span className="text-red-400 ml-1">*</span>}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {toolStatus.installed && toolStatus.version
                      ? `v${toolStatus.version}`
                      : meta.description}
                  </p>
                </div>

                {isInstalling ? (
                  <span className="flex items-center gap-1.5 text-xs text-yellow-400 shrink-0">
                    <Loader2 className="size-3.5 animate-spin" />
                    Installing...
                  </span>
                ) : toolStatus.installed ? (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-400 shrink-0">
                    <Check className="size-3.5" />
                    Installed
                  </span>
                ) : (
                  <span className="text-xs text-red-400 shrink-0">Missing</span>
                )}

                {!toolStatus.installed && canInstall && !isInstalling && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleInstall(key)}
                    disabled={!!installing || needsPrereq}
                    className="ml-1 h-7 px-2.5 text-xs shrink-0"
                    title={needsPrereq ? 'Install Node.js first' : undefined}
                  >
                    <Download className="size-3 mr-1" />
                    Install
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Agent & Tool Setup</DialogTitle>
          <DialogDescription>
            Detect and install CLI tools used by 20x.{' '}
            {installedCount > 0 && `${installedCount}/${totalCount} installed.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {loading && !status ? (
            <div className="flex items-center justify-center py-8 gap-3 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              <span>Detecting installed tools...</span>
            </div>
          ) : (
            <>
              {/* Prerequisites warning */}
              {status && !hasPrerequisites && (
                <div className="flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 mb-4 text-sm">
                  <AlertTriangle className="size-4 text-yellow-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-yellow-400">Prerequisites missing</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Node.js and npm are required before installing coding agents. Install them first, or click &quot;Install All&quot; to set up everything in order.
                    </p>
                  </div>
                </div>
              )}

              {/* Status grid by category */}
              {renderCategory('prerequisite', 'Prerequisites')}
              {renderCategory('tool', 'Tools')}
              {renderCategory('agent', 'Coding Agents')}

              {/* Actions */}
              <div className="flex items-center gap-3 mb-4">
                {missingCount > 0 && (
                  <Button size="sm" onClick={handleInstallAll} disabled={!!installing}>
                    {installing ? (
                      <Loader2 className="size-3.5 animate-spin mr-1.5" />
                    ) : (
                      <Download className="size-3.5 mr-1.5" />
                    )}
                    Install All Missing ({missingCount})
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={detect} disabled={!!installing}>
                  <RefreshCw className={`size-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
                {missingCount === 0 && status && (
                  <span className="text-xs text-emerald-400 flex items-center gap-1.5">
                    <Check className="size-3.5" />
                    All tools are installed!
                  </span>
                )}
              </div>

              {/* Terminal output */}
              {terminalOutput && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Terminal className="size-3.5" />
                      Installation output
                    </div>
                    <button
                      onClick={() => setTerminalOutput('')}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <div
                    ref={termRef}
                    className="bg-black/80 border border-border rounded-lg p-3 max-h-40 overflow-y-auto font-mono text-xs text-green-400 whitespace-pre-wrap"
                  >
                    {terminalOutput}
                  </div>
                </div>
              )}
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
