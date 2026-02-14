import { useEffect, useState, useCallback } from 'react'
import { Check, Copy, RefreshCw, ArrowRight, ExternalLink, Loader2, Bot } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import { depsApi, agentConfigApi } from '@/lib/ipc-client'
import { useAgentStore } from '@/stores/agent-store'
import { ProviderSetupStep } from '@/components/providers/ProviderSetupDialog'
import type { DepsStatus } from '@/types/electron'

/* ─── Types ─── */

interface InstallMethod {
  label: string
  command: string
}

interface DepStepDef {
  kind: 'dep'
  key: keyof DepsStatus
  title: string
  description: string
  url: string
  methods: InstallMethod[]
}

interface AgentStepDef {
  kind: 'agent'
}

interface ProviderStepDef {
  kind: 'provider'
}

type StepDef = DepStepDef | AgentStepDef | ProviderStepDef

/* ─── Constants ─── */

const DEP_STEPS: DepStepDef[] = [
  // OpenCode is now bundled as npm dependency - no installation needed!
  {
    kind: 'dep',
    key: 'gh',
    title: 'GitHub CLI',
    description: "GitHub's official command line tool for seamless repo and PR management.",
    url: 'https://cli.github.com/',
    methods: [
      { label: 'brew', command: 'brew install gh' },
      { label: 'conda', command: 'conda install gh --channel conda-forge' }
    ]
  }
]

const PROVIDER_STEP: ProviderStepDef = { kind: 'provider' }
const AGENT_STEP: AgentStepDef = { kind: 'agent' }

/* ─── Sub-components ─── */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="p-1.5 rounded text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
    </button>
  )
}

function InstallBlock({ methods }: { methods: InstallMethod[] }) {
  const [active, setActive] = useState(0)
  const safeActive = active < methods.length ? active : 0
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="flex gap-0 border-b border-border bg-muted/30">
        {methods.map((m, i) => (
          <button
            key={m.label}
            onClick={() => setActive(i)}
            className={`px-4 py-2.5 text-sm font-mono transition-colors relative ${
              i === safeActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/70'
            }`}
          >
            {m.label}
            {i === safeActive && (
              <span className="absolute bottom-0 left-4 right-4 h-0.5 bg-foreground rounded-full" />
            )}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 px-4 py-4 bg-background/40">
        <code className="flex-1 text-sm font-mono text-muted-foreground">
          {methods[safeActive].command}
        </code>
        <CopyButton text={methods[safeActive].command} />
      </div>
    </div>
  )
}

interface ModelOption {
  id: string
  name: string
}

function AgentSetupStep({
  onCreated,
  error,
  setError
}: {
  onCreated: () => void
  error: string | null
  setError: (e: string | null) => void
}) {
  const [name, setName] = useState('Robo')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(true)
  const [creating, setCreating] = useState(false)
  const { createAgent } = useAgentStore()

  useEffect(() => {
    let cancelled = false
    setLoadingModels(true)
    agentConfigApi.getProviders().then((result) => {
      if (cancelled) return
      if (result?.providers) {
        const list: ModelOption[] = []
        const providers = Array.isArray(result.providers) ? result.providers : []
        for (const p of providers) {
          const pModels = Array.isArray(p.models)
            ? p.models
            : p.models && typeof p.models === 'object'
              ? Object.values(p.models)
              : []
          for (const m of pModels as any[]) {
            if (m?.id) list.push({ id: `${p.id}/${m.id}`, name: `${p.name} – ${m.name || m.id}` })
          }
        }
        setModels(list)
        // Pre-select a free model from the "zen" provider
        if (list.length > 0) {
          const zenFree = list.find(
            (m) => m.name.toLowerCase().includes('free')
          )
          setModel(zenFree?.id || list[0].id)
        }
      }
    }).catch(() => {
      // Server not running — that's OK, user can pick later
    }).finally(() => {
      if (!cancelled) setLoadingModels(false)
    })
    return () => { cancelled = true }
  }, [])

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Agent name is required')
      return
    }
    setCreating(true)
    setError(null)
    try {
      await createAgent({
        name: name.trim(),
        config: {
          coding_agent: 'opencode',
          model: model || undefined
        },
        is_default: true
      })
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

      <h2 className="text-2xl font-bold text-foreground mb-2">
        Add your first agent
      </h2>
      <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
        Set up an AI coding agent to work on your tasks.
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
                <option key={m.id} value={m.id}>{m.name}</option>
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
          {!loadingModels && models.length === 0 && (
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
          Create agent
        </Button>
      </div>
    </>
  )
}

/* ─── Main component ─── */

const FORCE_ONBOARDING = () => localStorage.getItem('debug:onboarding') === 'true'

export function DepsWarningBanner() {
  const [status, setStatus] = useState<DepsStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [checking, setChecking] = useState(false)
  const [step, setStep] = useState(0)
  const [steps, setSteps] = useState<StepDef[]>([])
  const [error, setError] = useState<string | null>(null)
  const { agents, fetchAgents } = useAgentStore()

  const check = useCallback(async () => {
    setChecking(true)
    try {
      const result = await depsApi.check()
      setStatus(result)
      return result
    } catch {
      return null
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    const force = FORCE_ONBOARDING()
    Promise.all([check(), fetchAgents(), agentConfigApi.getProviders()]).then(([result, _, providers]) => {
      if (!result) return
      const depSteps = force
        ? (DEP_STEPS as StepDef[])
        : (DEP_STEPS.filter((s) => !result[s.key]) as StepDef[])

      // Only show provider setup if no existing providers are configured
      const hasProviders = providers && providers.providers && providers.providers.length > 0
      const providerSteps = (force || !hasProviders) ? [PROVIDER_STEP] : []

      if (hasProviders) {
        console.log('[Onboarding] Found existing providers, skipping provider setup:', providers.providers.map(p => p.id))
      }

      // Read fresh agent count from store (not stale closure)
      const hasAgents = useAgentStore.getState().agents.length > 0
      const agentSteps = force || !hasAgents ? [AGENT_STEP] : []
      setSteps([...depSteps, ...providerSteps, ...agentSteps])
    })
  }, [])

  // Re-evaluate agent step when agents change (skip in force mode)
  useEffect(() => {
    if (agents.length > 0 && !FORCE_ONBOARDING()) {
      setSteps((prev) => prev.filter((s) => s.kind !== 'agent'))
    }
  }, [agents.length])

  const advance = useCallback(async () => {
    setError(null)
    const current = steps[step]
    if (!current || current.kind !== 'dep') return

    const force = FORCE_ONBOARDING()
    const result = await check()
    if (!result) return

    if (!force && !result[current.key]) {
      setError(`${current.title} is not detected yet. Please install it first.`)
      return
    }
    if (force) {
      // In force mode just advance without removing steps
      if (step < steps.length - 1) setStep(step + 1)
      else setDismissed(true)
      return
    }
    // Installed — remove from steps and advance
    const remaining = steps.filter((s) => s.kind !== 'dep' || s.key !== current.key)
    setSteps(remaining)
    setStep((prev) => Math.min(prev, remaining.length - 1))
  }, [check, steps, step])

  const skip = useCallback(() => {
    setError(null)
    if (step >= steps.length - 1) {
      setDismissed(true)
    } else {
      setStep(step + 1)
    }
  }, [step, steps.length])

  const isOpen = !dismissed && steps.length > 0
  const current = steps[step]
  const isLast = step === steps.length - 1
  const totalSteps = steps.length

  if (!status && !steps.some((s) => s.kind === 'agent')) return null
  if (!current) return null

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && setDismissed(true)}>
      <DialogContent className="max-w-lg">
        <div className="px-8 pt-8 pb-6">
          {/* Step indicator */}
          {totalSteps > 1 && (
            <div className="flex items-center gap-1.5 mb-6">
              {steps.map((_, i) => (
                <div
                  key={i}
                  className={`h-1 rounded-full transition-colors ${
                    i === step ? 'w-6 bg-primary' : 'w-6 bg-border'
                  }`}
                />
              ))}
            </div>
          )}

          {/* Step label */}
          <p className="text-xs font-medium text-primary mb-3 tracking-wide uppercase">
            Step {step + 1} of {totalSteps}
          </p>

          {current.kind === 'dep' ? (
            <>
              {/* Dep install step */}
              <h2 className="text-2xl font-bold text-foreground mb-2">
                Install {current.title}
              </h2>
              <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
                {current.description}
              </p>
              <InstallBlock methods={current.methods} />

              {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

              <div className="flex items-center gap-3 mt-6">
                <Button onClick={advance} disabled={checking}>
                  {checking ? (
                    <RefreshCw className="size-4 animate-spin" />
                  ) : isLast ? (
                    <Check className="size-4" />
                  ) : (
                    <ArrowRight className="size-4" />
                  )}
                  {isLast ? 'Done' : 'Next'}
                </Button>
                <Button variant="ghost" onClick={skip}>
                  Skip
                </Button>
                <button
                  onClick={() => window.open(current.url, '_blank')}
                  className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Website
                  <ExternalLink className="size-3" />
                </button>
              </div>
            </>
          ) : current.kind === 'provider' ? (
            /* Provider setup step */
            <ProviderSetupStep
              error={error}
              setError={setError}
              onComplete={() => {
                if (isLast) {
                  setDismissed(true)
                } else {
                  setStep(step + 1)
                }
              }}
            />
          ) : (
            /* Agent setup step */
            <AgentSetupStep
              error={error}
              setError={setError}
              onCreated={() => {
                if (isLast) {
                  setDismissed(true)
                } else {
                  setStep(step + 1)
                }
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
