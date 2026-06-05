import { useEffect, useState, useCallback } from 'react'
import {
  Check,
  Loader2,
  AlertTriangle,
  ArrowRight,
  Download,
  Sparkles,
  Zap
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
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
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { useDashboardStore } from '@/stores/dashboard-store'
import { EnterpriseLoginModal } from '@/components/settings/tabs/EnterpriseLoginModal'
import { PresetupWizard } from '@/components/dashboard/PresetupWizard'
import { CodingAgentType, CLAUDE_MODELS, CODEX_MODELS } from '@/types'
import { agentConfigApi } from '@/lib/ipc-client'
import type { ToolStatus } from '@/types/electron'
import type { PresetupTemplate } from '@/stores/dashboard-store'

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

/* ─── Agent card metadata ─── */

type AgentChoice = CodingAgentType | 'peakflo'

interface AgentOption {
  type: AgentChoice
  label: string
  tagline: string
  color: string
  letter: string
}

const AGENT_OPTIONS: AgentOption[] = [
  {
    type: CodingAgentType.CLAUDE_CODE,
    label: 'Claude Code',
    tagline: 'Anthropic',
    color: 'bg-amber-600',
    letter: 'C'
  },
  {
    type: CodingAgentType.OPENCODE,
    label: 'OpenCode',
    tagline: 'Open-source, free models',
    color: 'bg-blue-600',
    letter: 'O'
  },
  {
    type: CodingAgentType.CODEX,
    label: 'Codex',
    tagline: 'OpenAI',
    color: 'bg-purple-600',
    letter: 'X'
  }
]

/* ─── Tool status helpers ─── */

function getAgentToolKey(type: CodingAgentType): string {
  switch (type) {
    case CodingAgentType.CLAUDE_CODE:
      return 'claudeCode'
    case CodingAgentType.OPENCODE:
      return 'opencode'
    case CodingAgentType.CODEX:
      return 'codex'
  }
}

/* ─── Auto-select best default model ─── */

async function getDefaultModel(type: CodingAgentType): Promise<string> {
  if (type === CodingAgentType.CLAUDE_CODE) {
    return CLAUDE_MODELS[0]?.id || ''
  }
  if (type === CodingAgentType.CODEX) {
    return CODEX_MODELS[0]?.id || ''
  }
  // OpenCode — try to fetch, fall back gracefully
  try {
    const result = await agentConfigApi.getProviders(undefined, CodingAgentType.OPENCODE)
    if (result?.providers) {
      const providers = Array.isArray(result.providers) ? result.providers : []
      for (const p of providers) {
        if (Array.isArray(p.models)) {
          for (const m of p.models as { id?: string; name?: string }[]) {
            if (m?.id) {
              const name = (m.name || '').toLowerCase()
              if (name.includes('free')) return `${p.id}/${m.id}`
            }
          }
          const first = (p.models as { id?: string }[])[0]
          if (first?.id) return `${p.id}/${first.id}`
        } else if (p.models && typeof p.models === 'object') {
          for (const [key, m] of Object.entries(
            p.models as Record<string, { id?: string; name?: string }>
          )) {
            const modelId = m?.id || key
            if (modelId) return `${p.id}/${modelId}`
          }
        }
      }
    }
  } catch {
    // Silently fail — user can configure model later in settings
  }
  return ''
}

/* ─── Helpers ─── */

function hasCompleteDefaultAgent(): boolean {
  const agents = useAgentStore.getState().agents
  return agents.some((a) => a.is_default && !!a.config.coding_agent && !!a.config.model)
}

/* ─── Git Provider Choice (inline, optional) ─── */

type ProviderChoice = GitProvider | 'none'

function GitProviderRow({
  selected,
  onSelect,
  toolStatus
}: {
  selected: ProviderChoice | null
  onSelect: (p: ProviderChoice) => void
  toolStatus: Record<string, ToolStatus> | null
}) {
  const options: { value: ProviderChoice; label: string; cliKey: string; cliName: string }[] = [
    { value: 'github', label: 'GitHub', cliKey: 'gh', cliName: 'gh' },
    { value: 'gitlab', label: 'GitLab', cliKey: 'glab', cliName: 'glab' }
  ]

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">
        Where are your repos? <span className="opacity-60">(optional)</span>
      </p>
      <div className="flex gap-2">
        {options.map((opt) => {
          const cli = toolStatus?.[opt.cliKey]
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSelect(selected === opt.value ? 'none' : opt.value)}
              className={`px-3 py-1.5 rounded-md border text-xs font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                selected === opt.value
                  ? 'border-primary bg-primary/5 text-foreground'
                  : 'border-border text-muted-foreground hover:border-muted-foreground/40'
              }`}
            >
              {opt.label}
              {selected === opt.value && <Check className="inline size-3" />}
              {toolStatus && cli?.installed && (
                <span className="text-emerald-400 text-[10px] font-normal flex items-center gap-0.5">
                  <Check className="size-2.5" />
                  {opt.cliName}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ─── Onboarding step type ─── */

type OnboardingScreen = 'main' | 'templates'

/* ─── Main OnboardingWizard ─── */

interface OnboardingWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function OnboardingWizard({ open, onOpenChange }: OnboardingWizardProps) {
  const [screen, setScreen] = useState<OnboardingScreen>('main')
  const [selectedAgent, setSelectedAgent] = useState<AgentChoice | null>(null)
  const [providerChoice, setProviderChoice] = useState<ProviderChoice | null>(null)
  const [toolStatus, setToolStatus] = useState<Record<string, ToolStatus> | null>(null)
  const [creating, setCreating] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loginModalOpen, setLoginModalOpen] = useState(false)
  const [wizardTemplate, setWizardTemplate] = useState<PresetupTemplate | null>(null)
  const [wasAuthenticated, setWasAuthenticated] = useState(false)

  const { fetchAgents, agents, createAgent, updateAgent } = useAgentStore()
  const { fetchSettings, setGitProvider } = useSettingsStore()
  const { isAuthenticated, loadSession } = useEnterpriseStore()
  const { presetupTemplates, fetchPresetups } = useDashboardStore()

  // Initialize state on open
  useEffect(() => {
    if (!open) return
    setError(null)
    setScreen('main')

    Promise.all([fetchAgents(), fetchSettings(), loadSession()]).then(() => {
      // Pre-select agent if one is already configured
      const existing = useAgentStore.getState().agents.find(
        (a) => a.is_default && a.config.coding_agent
      )
      if (existing?.config.coding_agent) {
        setSelectedAgent(existing.config.coding_agent as CodingAgentType)
      }
      // Restore git provider choice
      const gp = useSettingsStore.getState().gitProvider
      if (gp) setProviderChoice(gp)
    })

    // Detect tools in background
    window.electronAPI.agentInstaller
      .detect()
      .then(setToolStatus)
      .catch(() => {})
  }, [open, fetchAgents, fetchSettings, loadSession])

  // Listen for install progress events
  useEffect(() => {
    if (!open) return
    const cleanup = window.electronAPI.agentInstaller.onProgress(
      (data: { stage: string }) => {
        if (data.stage === 'complete' || data.stage === 'error') {
          setInstalling(null)
          window.electronAPI.agentInstaller
            .detect()
            .then(setToolStatus)
            .catch(() => {})
        }
      }
    )
    return cleanup
  }, [open])

  // After enterprise login completes, fetch templates
  useEffect(() => {
    if (isAuthenticated && !wasAuthenticated) {
      fetchPresetups()
    }
    setWasAuthenticated(isAuthenticated)
  }, [isAuthenticated, wasAuthenticated, fetchPresetups])

  const handleInstall = useCallback(async (toolKey: string) => {
    setInstalling(toolKey)
    try {
      const result = (await window.electronAPI.agentInstaller.install(toolKey)) as {
        success: boolean
        error: string | null
        newStatus: Record<string, ToolStatus>
      }
      if (result?.newStatus) {
        setToolStatus(result.newStatus)
      } else {
        const fresh = await window.electronAPI.agentInstaller.detect()
        setToolStatus(fresh)
      }
    } catch {
      const fresh = await window.electronAPI.agentInstaller.detect()
      setToolStatus(fresh)
    } finally {
      setInstalling(null)
    }
  }, [])

  const handleProviderSelect = useCallback(
    async (p: ProviderChoice) => {
      setProviderChoice(p)
      await setGitProvider(p === 'none' ? null : p)
    },
    [setGitProvider]
  )

  const createDefaultAgent = useCallback(
    async (agentType: CodingAgentType) => {
      const model = await getDefaultModel(agentType)

      const existingDefault = agents.find(
        (a) => a.is_default && (!a.config.coding_agent || !a.config.model)
      )

      if (existingDefault) {
        await updateAgent(existingDefault.id, {
          name: existingDefault.name || 'Robo',
          config: {
            ...existingDefault.config,
            coding_agent: agentType,
            model: model || undefined
          }
        })
      } else if (!hasCompleteDefaultAgent()) {
        await createAgent({
          name: 'Robo',
          config: {
            coding_agent: agentType,
            model: model || undefined
          },
          is_default: true
        })
      }
    },
    [agents, createAgent, updateAgent]
  )

  const handleStart = async () => {
    if (!selectedAgent) return
    setCreating(true)
    setError(null)

    try {
      if (selectedAgent === 'peakflo') {
        // Open login modal — after auth, handleLoginClose transitions forward
        setLoginModalOpen(true)
        setCreating(false)
        return
      }

      // BYO agent path — create default agent and close
      await createDefaultAgent(selectedAgent)
      onOpenChange(false)
    } catch {
      setError('Failed to set up agent. You can configure it later in Settings.')
    } finally {
      setCreating(false)
    }
  }

  // After enterprise login modal closes
  const handleLoginClose = useCallback(async () => {
    setLoginModalOpen(false)
    const auth = useEnterpriseStore.getState().isAuthenticated
    if (!auth) return // User cancelled

    // Auto-install OpenCode + create default agent
    setCreating(true)
    try {
      if (!hasCompleteDefaultAgent()) {
        const status = await window.electronAPI.agentInstaller.detect()
        setToolStatus(status)
        if (!status.opencode?.installed) {
          setInstalling('opencode')
          await window.electronAPI.agentInstaller.install('opencode')
          setInstalling(null)
        }
        await createDefaultAgent(CodingAgentType.OPENCODE)
      }

      // Fetch templates and show them if available
      await fetchPresetups()
      const templates = useDashboardStore.getState().presetupTemplates
      if (templates.length > 0) {
        setScreen('templates')
      } else {
        onOpenChange(false)
      }
    } catch {
      const templates = useDashboardStore.getState().presetupTemplates
      if (templates.length > 0) {
        setScreen('templates')
      } else {
        onOpenChange(false)
      }
    } finally {
      setCreating(false)
    }
  }, [createDefaultAgent, fetchPresetups, onOpenChange])

  const handleSkip = () => {
    onOpenChange(false)
  }

  // Compute tool health for the selected BYO agent
  const selectedCodingAgent =
    selectedAgent && selectedAgent !== 'peakflo' ? selectedAgent : null

  const agentInstalled =
    selectedCodingAgent && toolStatus
      ? toolStatus[getAgentToolKey(selectedCodingAgent)]?.installed
      : null

  /* ─── Render: Templates screen ─── */

  if (screen === 'templates') {
    return (
      <>
        <Dialog open={open} onOpenChange={(o) => !o && handleSkip()}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Start with a template</DialogTitle>
              <DialogDescription>
                Set up pre-built workflows for your team, or do it later from the Dashboard.
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {presetupTemplates.map((template) => (
                  <button
                    key={template.slug}
                    type="button"
                    onClick={() => setWizardTemplate(template)}
                    className="rounded-lg border border-border bg-card p-4 text-left transition-all hover:border-primary/40 hover:bg-secondary/30 cursor-pointer group"
                  >
                    <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
                      {template.name}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {template.description}
                    </p>
                    <span className="inline-flex items-center gap-1 text-xs text-primary mt-2 font-medium">
                      Set up <ArrowRight className="size-3" />
                    </span>
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-3 pt-2">
                <Button onClick={() => onOpenChange(false)} className="flex-1">
                  Done
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  className="text-muted-foreground"
                >
                  Set up later
                </Button>
              </div>
            </DialogBody>
          </DialogContent>
        </Dialog>

        {wizardTemplate && (
          <PresetupWizard
            template={wizardTemplate}
            onClose={() => setWizardTemplate(null)}
          />
        )}
      </>
    )
  }

  /* ─── Render: Main screen ─── */

  return (
    <>
      <Dialog open={open && !loginModalOpen} onOpenChange={(o) => !o && handleSkip()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Welcome to 20x</DialogTitle>
            <DialogDescription>
              AI-powered task management for software teams
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-5">
            {/* ── Peakflo option ── */}
            <div>
              <button
                type="button"
                onClick={() => setSelectedAgent('peakflo')}
                className={`w-full flex items-center gap-3 rounded-xl border-2 p-4 transition-all cursor-pointer ${
                  selectedAgent === 'peakflo'
                    ? 'border-primary bg-primary/5 shadow-md'
                    : 'border-border hover:border-muted-foreground/40 hover:bg-muted/20'
                }`}
              >
                <div className="bg-gradient-to-br from-primary to-primary/70 rounded-full size-10 flex items-center justify-center text-white shrink-0">
                  <Zap className="size-5" />
                </div>
                <div className="text-left flex-1">
                  <p className="text-sm font-semibold text-foreground">Peakflo</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Managed agents, workflows &amp; integrations
                  </p>
                </div>
                {selectedAgent === 'peakflo' && (
                  <Check className="size-4 text-primary shrink-0" />
                )}
              </button>
            </div>

            {/* ── BYO agent options ── */}
            <div>
              <p className="text-xs text-muted-foreground mb-2">
                Or bring your own agent:
              </p>
              <div className="grid grid-cols-3 gap-2.5">
                {AGENT_OPTIONS.map((agent) => {
                  const isSelected = selectedAgent === agent.type
                  const toolKey = getAgentToolKey(agent.type as CodingAgentType)
                  const detected = toolStatus?.[toolKey]
                  const isInstalled = detected?.installed === true
                  return (
                    <button
                      key={agent.type}
                      type="button"
                      onClick={() => setSelectedAgent(agent.type)}
                      className={`group relative flex flex-col items-center gap-2 rounded-xl border-2 p-3 transition-all cursor-pointer ${
                        isSelected
                          ? 'border-primary bg-primary/5 shadow-md'
                          : 'border-border hover:border-muted-foreground/40 hover:bg-muted/20'
                      }`}
                    >
                      <div
                        className={`${agent.color} rounded-full size-9 flex items-center justify-center text-white text-sm font-bold transition-transform ${
                          isSelected ? 'scale-110' : 'group-hover:scale-105'
                        }`}
                      >
                        {agent.letter}
                      </div>
                      <div className="text-center">
                        <p className="text-xs font-semibold text-foreground leading-tight">
                          {agent.label}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {agent.tagline}
                        </p>
                      </div>
                      {/* Detected status */}
                      {toolStatus && (
                        <span className={`text-[10px] flex items-center gap-0.5 ${
                          isInstalled ? 'text-emerald-400' : 'text-muted-foreground/50'
                        }`}>
                          {isInstalled ? (
                            <>
                              <Check className="size-2.5" />
                              {detected?.version ? `v${detected.version}` : 'Installed'}
                            </>
                          ) : (
                            'Not installed'
                          )}
                        </span>
                      )}
                      {isSelected && (
                        <div className="absolute top-1.5 right-1.5">
                          <Check className="size-3.5 text-primary" />
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* ── Git provider (optional, BYO only) ── */}
            {selectedAgent && selectedAgent !== 'peakflo' && (
              <GitProviderRow
                selected={providerChoice}
                onSelect={handleProviderSelect}
                toolStatus={toolStatus}
              />
            )}

            {/* ── Install prompt (only when selected agent is not installed) ── */}
            {toolStatus && selectedCodingAgent && agentInstalled === false && (
              <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border bg-muted/20 text-xs">
                <AlertTriangle className="size-4 text-amber-400 shrink-0" />
                <span className="text-muted-foreground flex-1">
                  {AGENT_OPTIONS.find((a) => a.type === selectedCodingAgent)?.label} will be installed automatically
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-[10px]"
                  disabled={!!installing}
                  onClick={() => handleInstall(getAgentToolKey(selectedCodingAgent))}
                >
                  {installing === getAgentToolKey(selectedCodingAgent) ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <>
                      <Download className="size-2.5 mr-0.5" />
                      Install now
                    </>
                  )}
                </Button>
              </div>
            )}

            {/* ── Error ── */}
            {error && <p className="text-xs text-destructive">{error}</p>}

            {/* ── Actions ── */}
            <div className="flex items-center gap-3">
              <Button
                onClick={handleStart}
                disabled={!selectedAgent || creating}
                className="flex-1"
              >
                {creating ? (
                  <Loader2 className="size-4 animate-spin mr-1.5" />
                ) : selectedAgent === 'peakflo' ? (
                  <Zap className="size-4 mr-1.5" />
                ) : (
                  <Sparkles className="size-4 mr-1.5" />
                )}
                {selectedAgent === 'peakflo' ? 'Sign up / Log in' : 'Get Started'}
                {!creating && <ArrowRight className="size-4 ml-1.5" />}
              </Button>
              <Button
                variant="ghost"
                onClick={handleSkip}
                className="text-muted-foreground"
              >
                Skip
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* Enterprise login modal — opens when user picks Peakflo */}
      <EnterpriseLoginModal open={loginModalOpen} onClose={handleLoginClose} />
    </>
  )
}
