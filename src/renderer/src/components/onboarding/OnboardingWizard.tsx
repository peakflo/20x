import React, { useEffect, useState, useCallback } from 'react'
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
import { useProgressToastStore } from '@/stores/progress-toast-store'
import { EnterpriseLoginModal } from '@/components/settings/tabs/EnterpriseLoginModal'
import { PresetupWizard } from '@/components/dashboard/PresetupWizard'
import { CodingAgentType, CLAUDE_MODELS, CODEX_MODELS } from '@/types'
import { agentConfigApi } from '@/lib/ipc-client'
import { AnthropicLogo, OpenCodeLogo, OpenAILogo } from '@/components/icons/AgentLogos'
import type { ToolStatus } from '@/types/electron'
import type { PresetupTemplate } from '@/stores/dashboard-store'

/* ─── Enums & Constants ─── */

enum OnboardingScreen {
  MAIN = 'main',
  TEMPLATES = 'templates'
}

enum AgentChoiceType {
  PEAKFLO = 'peakflo'
}

enum DetectKey {
  CLAUDE_CODE = 'claudeCode',
  OPENCODE = 'opencode',
  CODEX = 'codex',
  GH = 'gh',
  GLAB = 'glab'
}

enum ProviderChoiceValue {
  NONE = 'none'
}

const STORAGE_KEYS = {
  DEBUG_ONBOARDING: 'debug:onboarding',
  FORCE_ONBOARDING: 'force-onboarding'
} as const

const DEFAULT_AGENT_NAME = 'Robo'

/* ─── Force-onboarding flag ─── */

export function isForceOnboarding(): boolean {
  return (
    localStorage.getItem(STORAGE_KEYS.DEBUG_ONBOARDING) === 'true' ||
    localStorage.getItem(STORAGE_KEYS.FORCE_ONBOARDING) === 'true'
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

type AgentChoice = CodingAgentType | AgentChoiceType.PEAKFLO

interface AgentOption {
  type: AgentChoice
  label: string
  tagline: string
  Logo: React.ComponentType<{ className?: string }>
}

const AGENT_OPTIONS: AgentOption[] = [
  {
    type: CodingAgentType.CLAUDE_CODE,
    label: 'Claude Code',
    tagline: 'Anthropic',
    Logo: AnthropicLogo
  },
  {
    type: CodingAgentType.OPENCODE,
    label: 'OpenCode',
    tagline: 'Open-source, free models',
    Logo: OpenCodeLogo
  },
  {
    type: CodingAgentType.CODEX,
    label: 'Codex',
    tagline: 'OpenAI',
    Logo: OpenAILogo
  }
]

/* ─── Tool status helpers ─── */

function getAgentToolKey(type: CodingAgentType): DetectKey {
  switch (type) {
    case CodingAgentType.CLAUDE_CODE:
      return DetectKey.CLAUDE_CODE
    case CodingAgentType.OPENCODE:
      return DetectKey.OPENCODE
    case CodingAgentType.CODEX:
      return DetectKey.CODEX
  }
}

/* ─── Auto-select best default model ─── */

const PEAKFLO_PROVIDER_ID = 'peakflo'

/** Pick first model from a provider's model list (array or object). */
function pickFirstModel(
  providerId: string,
  models: unknown
): string | null {
  if (Array.isArray(models)) {
    for (const m of models as { id?: string; name?: string }[]) {
      if (m?.id) return `${providerId}/${m.id}`
    }
  } else if (models && typeof models === 'object') {
    for (const [key, m] of Object.entries(models as Record<string, { id?: string }>)) {
      const modelId = m?.id || key
      if (modelId) return `${providerId}/${modelId}`
    }
  }
  return null
}

/** Pick first "free" model from a provider's model list. */
function pickFreeModel(
  providerId: string,
  models: unknown
): string | null {
  if (!Array.isArray(models)) return null
  for (const m of models as { id?: string; name?: string }[]) {
    if (m?.id && (m.name || '').toLowerCase().includes('free')) {
      return `${providerId}/${m.id}`
    }
  }
  return null
}

async function getDefaultModel(type: CodingAgentType): Promise<string> {
  if (type === CodingAgentType.CLAUDE_CODE) {
    return CLAUDE_MODELS[0]?.id || ''
  }
  if (type === CodingAgentType.CODEX) {
    return CODEX_MODELS[0]?.id || ''
  }
  // OpenCode — try to fetch providers, prefer Peakflo gateway if authenticated
  try {
    const result = await agentConfigApi.getProviders(undefined, CodingAgentType.OPENCODE)
    if (result?.providers) {
      const providers = Array.isArray(result.providers) ? result.providers : []

      // 1. If authenticated via Peakflo, prefer the Peakflo gateway model
      const peakfloProvider = providers.find((p) => p.id === PEAKFLO_PROVIDER_ID)
      if (peakfloProvider) {
        const model = pickFirstModel(PEAKFLO_PROVIDER_ID, peakfloProvider.models)
        if (model) return model
      }

      // 2. Otherwise, pick first free model from any provider
      for (const p of providers) {
        const free = pickFreeModel(p.id, p.models)
        if (free) return free
      }

      // 3. Fall back to first model from first provider
      for (const p of providers) {
        const first = pickFirstModel(p.id, p.models)
        if (first) return first
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

type ProviderChoice = GitProvider | ProviderChoiceValue.NONE

interface GitProviderOption {
  value: ProviderChoice
  label: string
  cliKey: DetectKey
  cliName: string
}

const GIT_PROVIDER_OPTIONS: GitProviderOption[] = [
  { value: 'github', label: 'GitHub', cliKey: DetectKey.GH, cliName: 'gh' },
  { value: 'gitlab', label: 'GitLab', cliKey: DetectKey.GLAB, cliName: 'glab' }
]

function GitProviderRow({
  selected,
  onSelect,
  toolStatus
}: {
  selected: ProviderChoice | null
  onSelect: (p: ProviderChoice) => void
  toolStatus: Record<string, ToolStatus> | null
}) {

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">
        Where are your repos? <span className="opacity-60">(optional)</span>
      </p>
      <div className="flex gap-2">
        {GIT_PROVIDER_OPTIONS.map((opt) => {
          const cli = toolStatus?.[opt.cliKey]
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSelect(selected === opt.value ? ProviderChoiceValue.NONE : opt.value)}
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

/* ─── Main OnboardingWizard ─── */

interface OnboardingWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function OnboardingWizard({ open, onOpenChange }: OnboardingWizardProps) {
  const [screen, setScreen] = useState(OnboardingScreen.MAIN)
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
    setScreen(OnboardingScreen.MAIN)

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
      await setGitProvider(p === ProviderChoiceValue.NONE ? null : p)
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
          name: existingDefault.name || DEFAULT_AGENT_NAME,
          config: {
            ...existingDefault.config,
            coding_agent: agentType,
            model: model || undefined
          }
        })
      } else if (!hasCompleteDefaultAgent()) {
        await createAgent({
          name: DEFAULT_AGENT_NAME,
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

  /**
   * Run post-auth setup: kick off install + config in the background (toast),
   * then immediately advance the wizard to the templates screen so the user
   * can continue onboarding while the agent installs.
   */
  const setupRunning = React.useRef(false)
  const runPostAuthFlow = useCallback(async () => {
    // Guard against double-calls (useEffect + handleLoginClose can both fire)
    if (setupRunning.current) return
    setupRunning.current = true

    const toasts = useProgressToastStore.getState()
    const TOAST_ID = 'agent-setup'

    // Show background progress toast
    toasts.show(TOAST_ID, 'Setting up agent', 'Detecting installed tools...')

    // Move to templates screen immediately — don't wait for install
    fetchPresetups().then(() => {
      const templates = useDashboardStore.getState().presetupTemplates
      if (templates.length > 0) {
        setScreen(OnboardingScreen.TEMPLATES)
      } else {
        // No templates — close the dialog, toast is enough
        onOpenChange(false)
      }
    })

    try {
      // Phase 1: Detect tools
      const status = await window.electronAPI.agentInstaller.detect()
      setToolStatus(status)

      // Phase 2: Install OpenCode if needed
      if (!status.opencode?.installed) {
        toasts.update(TOAST_ID, { message: 'Installing OpenCode...', percent: 10 })

        // Subscribe to install progress events for real-time updates
        const cleanup = window.electronAPI.agentInstaller.onProgress(
          (data: { stage: string; percent: number; output: string }) => {
            if (data.stage === 'complete' || data.stage === 'error') return
            // Map install percent (0-100) to our range (10-50)
            const mapped = 10 + Math.round((data.percent || 0) * 0.4)
            toasts.update(TOAST_ID, { percent: mapped, message: data.output?.trim()?.slice(-60) || 'Installing OpenCode...' })
          }
        )

        try {
          await window.electronAPI.agentInstaller.install(DetectKey.OPENCODE)
        } finally {
          cleanup()
        }
      } else {
        toasts.update(TOAST_ID, { percent: 50, message: 'OpenCode already installed' })
      }

      // Phase 3: Start OpenCode server & configure agent + model
      toasts.update(TOAST_ID, { message: 'Starting OpenCode server...', percent: 55 })

      // createDefaultAgent calls getDefaultModel which calls getProviders,
      // which triggers ensureServerRunning() — this starts the server.
      // It also skips creation if a complete default agent already exists.
      toasts.update(TOAST_ID, { message: 'Configuring agent & model...', percent: 70 })
      await createDefaultAgent(CodingAgentType.OPENCODE)
      await useAgentStore.getState().fetchAgents()

      // Done!
      toasts.finish(TOAST_ID, 'Agent ready — you can start working!')
    } catch (err) {
      console.error('[OnboardingWizard] Background setup failed:', err)
      toasts.fail(TOAST_ID, 'Setup failed — configure agent in Settings')
    } finally {
      setupRunning.current = false
    }
  }, [createDefaultAgent, fetchPresetups, onOpenChange])

  // When auth completes while login modal is open, auto-close it and run post-auth flow.
  // This handles the browser signup flow where login/tenant-select happens in the background
  // and isAuthenticated flips to true while the modal is still showing.
  useEffect(() => {
    if (isAuthenticated && !wasAuthenticated && loginModalOpen) {
      setLoginModalOpen(false)
      runPostAuthFlow()
    }
    setWasAuthenticated(isAuthenticated)
  }, [isAuthenticated, wasAuthenticated, loginModalOpen, runPostAuthFlow])

  const handleStart = async () => {
    if (!selectedAgent) return
    setError(null)

    if (selectedAgent === AgentChoiceType.PEAKFLO) {
      if (isAuthenticated) {
        // Already authenticated — run background setup (closes dialog immediately)
        runPostAuthFlow()
        return
      }
      // Not authenticated — open login modal
      setLoginModalOpen(true)
      return
    }

    // BYO agent path — create default agent and close
    setCreating(true)
    try {
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
    await runPostAuthFlow()
  }, [runPostAuthFlow])

  const handleSkip = () => {
    onOpenChange(false)
  }

  // Compute tool health for the selected BYO agent
  const selectedCodingAgent =
    selectedAgent && selectedAgent !== AgentChoiceType.PEAKFLO ? selectedAgent : null

  const agentInstalled =
    selectedCodingAgent && toolStatus
      ? toolStatus[getAgentToolKey(selectedCodingAgent)]?.installed
      : null

  /* ─── Render: Templates screen ─── */

  if (screen === OnboardingScreen.TEMPLATES) {
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
              Get 20x more done with AI agents
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-5">
            {/* ── Peakflo option ── */}
            <div>
              <button
                type="button"
                onClick={() => setSelectedAgent(AgentChoiceType.PEAKFLO)}
                className={`w-full flex items-center gap-3 rounded-xl border-2 p-4 transition-all cursor-pointer ${
                  selectedAgent === AgentChoiceType.PEAKFLO
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
                {selectedAgent === AgentChoiceType.PEAKFLO && (
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
                      <agent.Logo
                        className={`size-9 transition-transform ${
                          isSelected ? 'scale-110' : 'group-hover:scale-105'
                        }`}
                      />
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
            {selectedAgent && selectedAgent !== AgentChoiceType.PEAKFLO && (
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
                ) : selectedAgent === AgentChoiceType.PEAKFLO ? (
                  <Zap className="size-4 mr-1.5" />
                ) : (
                  <Sparkles className="size-4 mr-1.5" />
                )}
                {selectedAgent === AgentChoiceType.PEAKFLO
                  ? (isAuthenticated ? 'Get Started' : 'Sign up / Log in')
                  : 'Get Started'}
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
