import { useEffect, useState, useRef, useCallback } from 'react'
import {
  Check,
  Download,
  Loader2,
  Terminal,
  RefreshCw,
  X,
  AlertTriangle,
  ArrowRight,
  Bot,
  Rocket,
  FolderOpen
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogTitle,
  DialogDescription
} from '@/components/ui/Dialog'
import { useAgentStore } from '@/stores/agent-store'
import { useSettingsStore, type GitProvider } from '@/stores/settings-store'
import { agentConfigApi, depsApi } from '@/lib/ipc-client'
import { CodingAgentType, CODING_AGENTS, CLAUDE_MODELS, CODEX_MODELS } from '@/types'
import type { ToolStatus } from '@/types/electron'

/* ─── Types ─── */

type OnboardingStep = 'welcome' | 'provider' | 'tools' | 'agent'

interface ProgressEvent {
  agentName: string
  stage: string
  output: string
  percent: number
}

/* ─── Force-onboarding flag ─── */

export function isForceOnboarding(): boolean {
  return (
    localStorage.getItem('debug:onboarding') === 'true' ||
    localStorage.getItem('force-onboarding') === 'true'
  )
}

/** Compare major.minor only — don't re-open for patch bumps */
export function shouldShowOnboarding(
  completedVersion: string | null | undefined,
  currentVersion: string
): boolean {
  if (isForceOnboarding()) return true
  if (!completedVersion) return true
  const [cMaj, cMin] = currentVersion.split('.').map(Number)
  const [sMaj, sMin] = completedVersion.split('.').map(Number)
  return cMaj !== sMaj || cMin !== sMin
}

/* ─── Tool metadata ─── */

const TOOL_META: Record<
  string,
  {
    label: string
    color: string
    letter: string
    required?: boolean
    description: string
    category: 'prerequisite' | 'agent' | 'tool'
  }
> = {
  nodejs: {
    label: 'Node.js',
    color: 'bg-green-600',
    letter: 'N',
    required: true,
    description: 'JavaScript runtime (required for all agents)',
    category: 'prerequisite'
  },
  npm: {
    label: 'npm',
    color: 'bg-red-600',
    letter: 'n',
    required: true,
    description: 'Package manager (included with Node.js)',
    category: 'prerequisite'
  },
  git: {
    label: 'Git',
    color: 'bg-orange-600',
    letter: 'G',
    description: 'Version control system',
    category: 'prerequisite'
  },
  gh: {
    label: 'GitHub CLI',
    color: 'bg-gray-600',
    letter: 'gh',
    description: 'GitHub command-line tool',
    category: 'tool'
  },
  glab: {
    label: 'GitLab CLI',
    color: 'bg-orange-500',
    letter: 'gl',
    description: 'GitLab command-line tool',
    category: 'tool'
  },
  claudeCode: {
    label: 'Claude Code',
    color: 'bg-amber-600',
    letter: 'C',
    description: "Anthropic's coding agent",
    category: 'agent'
  },
  opencode: {
    label: 'OpenCode',
    color: 'bg-blue-600',
    letter: 'O',
    description: 'Open-source coding agent (free models)',
    category: 'agent'
  },
  codex: {
    label: 'Codex',
    color: 'bg-purple-600',
    letter: 'X',
    description: "OpenAI's coding agent",
    category: 'agent'
  }
}

const INSTALLABLE = ['nodejs', 'npm', 'git', 'gh', 'glab', 'claudeCode', 'opencode', 'codex', 'pnpm']
const INSTALL_ORDER = ['nodejs', 'git', 'gh', 'glab', 'claudeCode', 'opencode', 'codex']

/* ─── Step 1: Welcome ─── */

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col items-center text-center py-4">
      <div className="rounded-full bg-primary/10 p-4 mb-6">
        <Rocket className="size-8 text-primary" />
      </div>

      <h2 className="text-2xl font-bold text-foreground mb-2">Welcome to 20x</h2>
      <p className="text-sm text-muted-foreground mb-8 leading-relaxed max-w-sm">
        AI-powered task management for software teams. Let&apos;s get your environment set up in a
        few quick steps.
      </p>

      <ul className="text-left text-sm text-muted-foreground space-y-3 mb-8 w-full max-w-xs">
        <li className="flex items-start gap-2.5">
          <Check className="size-4 text-primary mt-0.5 shrink-0" />
          <span>Detect &amp; install required CLI tools</span>
        </li>
        <li className="flex items-start gap-2.5">
          <Check className="size-4 text-primary mt-0.5 shrink-0" />
          <span>Configure your first coding agent</span>
        </li>
      </ul>

      <Button onClick={onNext} className="w-full max-w-xs">
        Get Started
        <ArrowRight className="size-4 ml-1.5" />
      </Button>
    </div>
  )
}

/* ─── Step 1b: Git Provider Choice ─── */

function ProviderChoiceStep({
  onNext,
  selectedProvider,
  onSelectProvider
}: {
  onNext: () => void
  selectedProvider: GitProvider | null
  onSelectProvider: (provider: GitProvider) => void
}) {
  const { setGitProvider } = useSettingsStore()

  const handleSelect = async (provider: GitProvider) => {
    onSelectProvider(provider)
    await setGitProvider(provider)
  }

  return (
    <div className="flex flex-col items-center text-center py-4">
      <h2 className="text-2xl font-bold text-foreground mb-2">Choose your Git provider</h2>
      <p className="text-sm text-muted-foreground mb-6 leading-relaxed max-w-sm">
        Select the platform where your repositories are hosted. This determines which CLI tool
        will be used for repo management.
      </p>

      <div className="grid grid-cols-2 gap-4 w-full max-w-md mb-8">
        {/* GitHub option */}
        <button
          type="button"
          onClick={() => handleSelect('github')}
          className={`flex flex-col items-center gap-3 rounded-xl border-2 p-6 transition-all ${
            selectedProvider === 'github'
              ? 'border-primary bg-primary/5 shadow-md'
              : 'border-border hover:border-muted-foreground/50 hover:bg-muted/30'
          }`}
        >
          <div className="bg-gray-600 rounded-full size-12 flex items-center justify-center text-white text-sm font-bold">
            gh
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">GitHub</p>
            <p className="text-xs text-muted-foreground mt-0.5">github.com</p>
          </div>
          {selectedProvider === 'github' && (
            <Check className="size-5 text-primary" />
          )}
        </button>

        {/* GitLab option */}
        <button
          type="button"
          onClick={() => handleSelect('gitlab')}
          className={`flex flex-col items-center gap-3 rounded-xl border-2 p-6 transition-all ${
            selectedProvider === 'gitlab'
              ? 'border-primary bg-primary/5 shadow-md'
              : 'border-border hover:border-muted-foreground/50 hover:bg-muted/30'
          }`}
        >
          <div className="bg-orange-500 rounded-full size-12 flex items-center justify-center text-white text-sm font-bold">
            gl
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">GitLab</p>
            <p className="text-xs text-muted-foreground mt-0.5">gitlab.com</p>
          </div>
          {selectedProvider === 'gitlab' && (
            <Check className="size-5 text-primary" />
          )}
        </button>
      </div>

      <Button onClick={onNext} disabled={!selectedProvider} className="w-full max-w-xs">
        Continue
        <ArrowRight className="size-4 ml-1.5" />
      </Button>
    </div>
  )
}

/* ─── Step 2: Tools & Agents ─── */

function ToolsAndAgentsStep({
  onNext,
  onSkip,
  selectedProvider
}: {
  onNext: () => void
  onSkip: () => void
  selectedProvider: GitProvider | null
}) {
  const [status, setStatus] = useState<Record<string, ToolStatus> | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [terminalOutput, setTerminalOutput] = useState('')
  const [loading, setLoading] = useState(true)
  const [customOpencodePath, setCustomOpencodePath] = useState('')
  const [savingPath, setSavingPath] = useState(false)
  const [pathError, setPathError] = useState<string | null>(null)
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

  useEffect(() => {
    detect()
    setTerminalOutput('')
  }, [detect])

  useEffect(() => {
    const cleanup = window.electronAPI.agentInstaller.onProgress((data: ProgressEvent) => {
      setTerminalOutput((prev) => prev + data.output)
      if (data.stage === 'complete' || data.stage === 'error') {
        setInstalling(null)
        detect()
      }
    })
    return cleanup
  }, [detect])

  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight
    }
  }, [terminalOutput])

  const handleInstall = async (agentName: string) => {
    setInstalling(agentName)
    setTerminalOutput(
      (prev) =>
        prev + `\n── Installing ${TOOL_META[agentName]?.label || agentName} ──\n`
    )
    try {
      const result = await window.electronAPI.agentInstaller.install(agentName) as { success: boolean; error: string | null; newStatus: Record<string, ToolStatus> }
      // On some platforms the install returns immediately without progress events
      // (e.g. glab/gh on macOS), so we must clear the installing state here.
      if (result && !result.success) {
        setTerminalOutput((prev) => prev + `${result.error || 'Installation not available on this platform.'}\n`)
        setInstalling(null)
        if (result.newStatus) setStatus(result.newStatus)
      }
    } catch (err) {
      setTerminalOutput((prev) => prev + `Error: ${err}\n`)
      setInstalling(null)
    }
  }

  const handleInstallAll = async () => {
    if (!status) return
    const missing = INSTALL_ORDER.filter((key) => {
      const s = status[key]
      return s && !s.installed
    })

    for (const agentName of missing) {
      const freshStatus = await window.electronAPI.agentInstaller.detect()
      setStatus(freshStatus)
      if (freshStatus[agentName]?.installed) continue

      setInstalling(agentName)
      setTerminalOutput(
        (prev) =>
          prev + `\n── Installing ${TOOL_META[agentName]?.label || agentName} ──\n`
      )
      try {
        const result = await window.electronAPI.agentInstaller.install(agentName) as { success: boolean; error: string | null; newStatus: Record<string, ToolStatus> }
        if (result && !result.success) {
          setTerminalOutput((prev) => prev + `${result.error || 'Installation not available on this platform.'}\n`)
          if (result.newStatus) setStatus(result.newStatus)
        }
      } catch (err) {
        setTerminalOutput((prev) => prev + `Error: ${err}\n`)
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    setInstalling(null)
    await detect()
  }

  const handleSetOpencodePath = async () => {
    if (!customOpencodePath.trim()) {
      setPathError('Please enter the directory path containing the binary.')
      return
    }
    setSavingPath(true)
    setPathError(null)
    try {
      const result = await depsApi.setOpencodePath(customOpencodePath.trim())
      if (result.success) {
        await detect()
      } else {
        setPathError(result.error || 'Binary not found at that path.')
      }
    } catch {
      setPathError('Failed to save path.')
    } finally {
      setSavingPath(false)
    }
  }

  const missingCount = status
    ? INSTALL_ORDER.filter((key) => status[key] && !status[key].installed).length
    : 0

  const installedCount = status
    ? Object.values(status).filter((v) => v?.installed).length
    : 0
  const totalCount = status ? Object.keys(status).length : 0

  const hasPrerequisites = status?.nodejs?.installed && status?.npm?.installed

  const renderCategory = (
    category: 'prerequisite' | 'agent' | 'tool',
    title: string
  ) => {
    const items = Object.entries(TOOL_META).filter(([key, meta]) => {
      if (meta.category !== category) return false
      // Only show the relevant CLI tool based on provider choice
      if (key === 'gh' && selectedProvider === 'gitlab') return false
      if (key === 'glab' && selectedProvider === 'github') return false
      return true
    })
    if (items.length === 0) return null

    return (
      <div className="mb-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5 px-1">
          {title}
        </p>
        <div className="grid gap-1.5">
          {items.map(([key, meta]) => {
            const toolStatus = status?.[key]
            if (!toolStatus) return null
            const isInstalling = installing === key
            const canInstall = INSTALLABLE.includes(key)
            const needsPrereq =
              !hasPrerequisites && meta.category === 'agent' && !toolStatus.installed

            return (
              <div
                key={key}
                className={`flex items-center gap-3 rounded-lg border border-border p-2.5 bg-background ${
                  needsPrereq ? 'opacity-60' : ''
                }`}
              >
                <div
                  className={`${meta.color} rounded-full size-8 flex items-center justify-center text-white text-xs font-bold shrink-0`}
                >
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
    <>
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
                  Node.js and npm are required before installing coding agents. Install them first,
                  or click &quot;Install All&quot; to set up everything in order.
                </p>
              </div>
            </div>
          )}

          {/* Status grid */}
          {renderCategory('prerequisite', 'Prerequisites')}
          {renderCategory('tool', 'Tools')}
          {renderCategory('agent', 'Coding Agents')}

          {/* Custom OpenCode path */}
          {status && !status.opencode?.installed && (
            <div className="mt-3 pt-3 border-t border-border">
              <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                Custom OpenCode path
              </p>
              <div className="flex gap-2">
                <Input
                  value={customOpencodePath}
                  onChange={(e) => setCustomOpencodePath(e.target.value)}
                  placeholder="e.g. /home/user/.opencode/bin"
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSetOpencodePath}
                  disabled={savingPath || !customOpencodePath.trim()}
                >
                  {savingPath ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <FolderOpen className="size-4" />
                  )}
                  Set
                </Button>
              </div>
              {pathError && <p className="text-xs text-destructive mt-1.5">{pathError}</p>}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 mt-4 mb-4">
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

          {/* Navigation */}
          <div className="flex items-center gap-3 mt-4 border-t border-border pt-4">
            <Button onClick={onNext}>
              Continue
              <ArrowRight className="size-4 ml-1.5" />
            </Button>
            <Button variant="ghost" onClick={onSkip}>
              Skip setup
            </Button>
            <span className="ml-auto text-xs text-muted-foreground">
              {installedCount}/{totalCount} installed
            </span>
          </div>
        </>
      )}
    </>
  )
}

/* ─── Step 4: Agent Configuration ─── */

interface ModelOption {
  id: string
  name: string
}

function AgentConfigStep({
  onCreated,
  error,
  setError
}: {
  onCreated: () => void
  error: string | null
  setError: (e: string | null) => void
}) {
  const [name, setName] = useState('Robo')
  const [codingAgent, setCodingAgent] = useState<CodingAgentType>(CodingAgentType.OPENCODE)
  const [model, setModel] = useState('')
  const [models, setModels] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(true)
  const [creating, setCreating] = useState(false)
  const { agents, createAgent, updateAgent } = useAgentStore()

  useEffect(() => {
    let cancelled = false
    setLoadingModels(true)
    setModel('')

    if (codingAgent === CodingAgentType.CLAUDE_CODE) {
      const list = CLAUDE_MODELS.map((m) => ({ id: m.id, name: m.name }))
      setModels(list)
      if (list.length > 0) setModel(list[0].id)
      setLoadingModels(false)
      return
    }

    if (codingAgent === CodingAgentType.CODEX) {
      const list = CODEX_MODELS.map((m) => ({ id: m.id, name: m.name }))
      setModels(list)
      if (list.length > 0) setModel(list[0].id)
      setLoadingModels(false)
      return
    }

    // OpenCode — fetch from server
    agentConfigApi
      .getProviders(undefined, CodingAgentType.OPENCODE)
      .then((result) => {
        if (cancelled) return
        if (result?.providers) {
          const list: ModelOption[] = []
          const providers = Array.isArray(result.providers) ? result.providers : []
          for (const p of providers) {
            if (Array.isArray(p.models)) {
              for (const m of p.models as { id?: string; name?: string }[]) {
                if (m?.id)
                  list.push({ id: `${p.id}/${m.id}`, name: `${p.name} – ${m.name || m.id}` })
              }
            } else if (p.models && typeof p.models === 'object') {
              // Use Object.entries so the map key serves as fallback model ID
              // (custom providers like routerAI may not have id on the value)
              for (const [key, m] of Object.entries(p.models as Record<string, { id?: string; name?: string }>)) {
                const modelId = m?.id || key
                if (modelId)
                  list.push({ id: `${p.id}/${modelId}`, name: `${p.name} – ${m?.name || modelId}` })
              }
            }
          }
          setModels(list)
          if (list.length > 0) {
            const zenFree = list.find((m) => m.name.toLowerCase().includes('free'))
            setModel(zenFree?.id || list[0].id)
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingModels(false)
      })
    return () => {
      cancelled = true
    }
  }, [codingAgent])

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Agent name is required')
      return
    }
    setCreating(true)
    setError(null)
    try {
      const existingDefault = agents.find(
        (a) => a.is_default && (!a.config.coding_agent || !a.config.model)
      )
      if (existingDefault) {
        await updateAgent(existingDefault.id, {
          name: name.trim(),
          config: {
            ...existingDefault.config,
            coding_agent: codingAgent,
            model: model || undefined
          }
        })
      } else {
        await createAgent({
          name: name.trim(),
          config: {
            coding_agent: codingAgent,
            model: model || undefined
          },
          is_default: true
        })
      }
      onCreated()
    } catch {
      setError('Failed to create agent')
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <div className="rounded-full bg-primary/10 p-2.5 w-fit mb-4">
        <Bot className="size-5 text-primary" />
      </div>

      <h2 className="text-2xl font-bold text-foreground mb-2">Set up your agent</h2>
      <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
        Configure your AI coding agent to work on tasks.
      </p>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="setup-agent-name">Agent name</Label>
          <Input
            id="setup-agent-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Robo"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="setup-coding-agent">Coding agent</Label>
          <select
            id="setup-coding-agent"
            value={codingAgent}
            onChange={(e) => setCodingAgent(e.target.value as CodingAgentType)}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
          >
            {CODING_AGENTS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="setup-agent-model">Model</Label>
          {loadingModels ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground border border-input rounded-md">
              <Loader2 className="size-4 animate-spin" />
              Loading models...
            </div>
          ) : models.length > 0 ? (
            <select
              id="setup-agent-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm cursor-pointer"
            >
              <option value="">Select a model...</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <Input
              id="setup-agent-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="provider/model-id"
            />
          )}
          {!loadingModels && models.length === 0 && codingAgent === CodingAgentType.OPENCODE && (
            <p className="text-xs text-muted-foreground">
              Could not load models from OpenCode server. You can configure this later in settings.
            </p>
          )}
        </div>
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="flex items-center gap-3 mt-6">
        <Button onClick={handleCreate} disabled={creating || !name.trim()}>
          {creating ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          {agents.find((a) => a.is_default && (!a.config.coding_agent || !a.config.model))
            ? 'Update agent'
            : 'Create agent'}
        </Button>
      </div>
    </>
  )
}

/* ─── Helpers ─── */

function hasCompleteDefaultAgent(): boolean {
  const agents = useAgentStore.getState().agents
  return agents.some((a) => a.is_default && !!a.config.coding_agent && !!a.config.model)
}

/* ─── Main OnboardingWizard ─── */

interface OnboardingWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function OnboardingWizard({ open, onOpenChange }: OnboardingWizardProps) {
  const [currentStep, setCurrentStep] = useState(0)
  const [steps, setSteps] = useState<OnboardingStep[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<GitProvider | null>(null)
  const { fetchAgents } = useAgentStore()
  const { fetchSettings, gitProvider } = useSettingsStore()

  // Build step list on open
  useEffect(() => {
    if (!open) return

    const force = isForceOnboarding()

    Promise.all([fetchAgents(), fetchSettings()]).then(() => {
      const stepList: OnboardingStep[] = ['welcome', 'provider', 'tools']

      // Agent config step — skip if default agent is fully configured
      if (force || !hasCompleteDefaultAgent()) {
        stepList.push('agent')
      }

      setSteps(stepList)
      setCurrentStep(0)
      setError(null)
      // Restore previously saved provider choice
      if (gitProvider) {
        setSelectedProvider(gitProvider)
      }
    })
  }, [open, fetchAgents, fetchSettings])

  const advance = useCallback(() => {
    setError(null)
    if (currentStep >= steps.length - 1) {
      onOpenChange(false)
    } else {
      setCurrentStep((s) => s + 1)
    }
  }, [currentStep, steps.length, onOpenChange])

  const dismiss = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const current = steps[currentStep]

  return (
    <Dialog open={open} onOpenChange={(o) => !o && dismiss()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {current === 'welcome'
              ? 'Welcome'
              : current === 'provider'
                ? 'Git Provider'
                : current === 'tools'
                  ? 'Agent & Tool Setup'
                  : current === 'agent'
                    ? 'Agent Configuration'
                    : 'Setup'}
          </DialogTitle>
          <DialogDescription>
            {steps.length > 1 && (
              <span className="text-xs">
                Step {currentStep + 1} of {steps.length}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        {steps.length > 1 && (
          <div className="flex items-center gap-1.5 px-6">
            {steps.map((_, i) => (
              <div
                key={i}
                className={`h-1 rounded-full transition-colors ${
                  i <= currentStep ? 'w-6 bg-primary' : 'w-6 bg-border'
                }`}
              />
            ))}
          </div>
        )}

        <DialogBody>
          {current === 'welcome' && <WelcomeStep onNext={advance} />}

          {current === 'provider' && (
            <ProviderChoiceStep
              onNext={advance}
              selectedProvider={selectedProvider}
              onSelectProvider={setSelectedProvider}
            />
          )}

          {current === 'tools' && <ToolsAndAgentsStep onNext={advance} onSkip={dismiss} selectedProvider={selectedProvider} />}

          {current === 'agent' && (
            <div className="px-2 pt-2 pb-2">
              <AgentConfigStep error={error} setError={setError} onCreated={advance} />
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
