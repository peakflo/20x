import { Plug, Terminal } from 'lucide-react'
import { AnthropicLogo, OpenAILogo, OpenCodeLogo, PiLogo } from '@/components/icons/AgentLogos'
import { cn } from '@/lib/utils'
import type { UsageProvider } from '@shared/usage'

/** Brand tints, matching the agent badges in Settings → Agents. */
export const PROVIDER_LOGO_TINT: Record<UsageProvider, string> = {
  'claude-code': 'text-orange-300/80',
  codex: 'text-emerald-300/80',
  opencode: 'text-blue-300/80',
  cursor: 'text-violet-300/80',
  pi: 'text-foreground/80',
  acp: 'text-sky-300/80'
}

/** Logo for a coding-agent harness. Inherits `currentColor` unless `tinted`. */
export function ProviderLogo({ provider, className, tinted = false }: { provider: UsageProvider; className?: string; tinted?: boolean }) {
  const classes = cn('shrink-0', tinted && PROVIDER_LOGO_TINT[provider], className)
  switch (provider) {
    case 'claude-code':
      return <AnthropicLogo className={classes} />
    case 'codex':
      return <OpenAILogo className={classes} />
    case 'opencode':
      return <OpenCodeLogo className={classes} />
    case 'cursor':
      return <Terminal className={classes} />
    case 'pi':
      return <PiLogo className={classes} />
    case 'acp':
      return <Plug className={classes} />
  }
}
