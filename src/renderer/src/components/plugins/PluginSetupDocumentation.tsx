/**
 * Plugin Setup Documentation Component
 *
 * Renders markdown documentation for plugin setup instructions.
 * Used in the Task Source configuration modal to provide step-by-step guides.
 */

import { Markdown } from '@/components/ui/Markdown'
import { cn } from '@/lib/utils'

interface PluginSetupDocumentationProps {
  markdown: string
  className?: string
}

export function PluginSetupDocumentation({ markdown, className }: PluginSetupDocumentationProps) {
  return <Markdown size="base" className={cn('max-w-none', className)}>{markdown}</Markdown>
}
