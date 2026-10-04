import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUsageStore } from '@/stores/usage-store'
import type { Agent } from '@/types'
import { USAGE_PROVIDER_LABELS, isUsageProvider, type UsageProvider } from '@shared/usage'
import { LimitWindowRow } from './ProviderLimitsCard'
import { ProviderLogo } from './ProviderLogo'

/** Delay before the card opens, so passing the pointer over the trigger does not flash it. */
const OPEN_DELAY_MS = 200

/** Harnesses whose plan limits can be read, and how they sign in for them. */
const LIMITS_HINT: Partial<Record<UsageProvider, string>> = {
  'claude-code': 'Plan limits appear once Claude Code runs with a subscription login.',
  codex: 'Plan limits appear once Codex runs with a ChatGPT login.',
  cursor: 'Plan limits appear for Cursor CLI logins (see Settings → Usage).',
  opencode: 'Plan limits are shown for OpenCode Go subscriptions only.'
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground text-right truncate">{value}</span>
    </div>
  )
}

/** Short agent details + its harness' subscription plan limits. */
export function AgentDetailsCard({ agent, className }: { agent: Agent; className?: string }) {
  const provider = isUsageProvider(agent.config?.coding_agent) ? agent.config.coding_agent : null
  const limits = useUsageStore((s) => (provider ? s.limits.find((l) => l.provider === provider) ?? null : null))
  const config = agent.config ?? {}
  const usesApiKey = config.auth_method === 'api_key'
  const mcpCount = config.mcp_servers?.length ?? 0
  const skillCount = config.skill_ids?.length ?? 0

  let limitsBody: ReactNode
  if (!provider || provider === 'pi') {
    limitsBody = <p className="text-[11px] text-muted-foreground">This harness does not report plan limits.</p>
  } else if (usesApiKey) {
    limitsBody = <p className="text-[11px] text-muted-foreground">API key — plan limits do not apply.</p>
  } else if (limits && limits.windows.length > 0) {
    limitsBody = (
      <div className="space-y-2.5">
        {limits.windows.map((window) => <LimitWindowRow key={window.id} window={window} />)}
      </div>
    )
  } else {
    limitsBody = (
      <p className="text-[11px] text-muted-foreground">
        {limits?.unavailable?.message ?? LIMITS_HINT[provider] ?? 'No plan limits reported yet.'}
      </p>
    )
  }

  return (
    <div
      className={cn('w-72 rounded-lg border border-border bg-card p-4 space-y-3 shadow-lg text-left leading-normal', className)}
      data-testid="agent-details-card"
    >
      <div className="flex items-center gap-2 min-w-0">
        {provider ? <ProviderLogo provider={provider} tinted className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5 shrink-0" />}
        <span className="text-sm font-semibold text-foreground truncate">{agent.name}</span>
        {limits?.planType && !usesApiKey && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium capitalize shrink-0">{limits.planType}</span>
        )}
      </div>

      <div className="space-y-1">
        <DetailRow label="Harness" value={provider ? USAGE_PROVIDER_LABELS[provider] : 'Unknown'} />
        <DetailRow label="Model" value={config.model || 'Default'} />
        {config.reasoning_effort && <DetailRow label="Reasoning" value={config.reasoning_effort} />}
        {provider !== 'opencode' && provider !== 'pi' && (
          <DetailRow label="Sign-in" value={usesApiKey ? 'API key' : 'Subscription'} />
        )}
        <DetailRow label="Permissions" value={config.permission_mode === 'allow' ? 'Auto-approve' : 'Ask'} />
        {(mcpCount > 0 || skillCount > 0) && (
          <DetailRow
            label="Tools"
            value={[mcpCount > 0 && `${mcpCount} MCP`, skillCount > 0 && `${skillCount} skill${skillCount === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
          />
        )}
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Plan limits</div>
        {limitsBody}
        {limits?.limitReached && !usesApiKey && (
          <p className="text-[11px] text-destructive">Limit reached — requests are blocked until the window resets.</p>
        )}
      </div>
    </div>
  )
}

interface AgentHoverCardProps {
  agent: Agent | null | undefined
  children: ReactNode
  /** Which edge of the trigger the card aligns to. */
  align?: 'left' | 'right'
  /** Open below (default) or above the trigger. */
  side?: 'bottom' | 'top'
  /** Suppress the card (e.g. while the trigger's own menu is open). */
  disabled?: boolean
  className?: string
}

/**
 * Shows `AgentDetailsCard` when the pointer rests on (or keyboard focus
 * enters) the wrapped trigger. Renders the trigger alone when there is no agent.
 */
export function AgentHoverCard({ agent, children, align = 'right', side = 'bottom', disabled = false, className }: AgentHoverCardProps) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const init = useUsageStore((s) => s.init)

  useEffect(() => init(), [init])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const show = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS)
  }
  const hide = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setOpen(false)
  }

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {agent && open && !disabled && (
        <span
          role="tooltip"
          className={cn(
            'absolute z-50',
            side === 'bottom' ? 'top-full pt-1.5' : 'bottom-full pb-1.5',
            align === 'right' ? 'right-0' : 'left-0'
          )}
        >
          <AgentDetailsCard agent={agent} />
        </span>
      )}
    </span>
  )
}
