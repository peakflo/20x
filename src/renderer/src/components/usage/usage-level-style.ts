import type { UsageLimitLevel } from '@shared/usage'

/**
 * Colors for usage meters, shared by the status bar, Settings → Usage and the
 * agent hover card: primary below 75%, yellow above 75%, red above 90%.
 * Single colors that read on both the light and the dark theme.
 */
export const USAGE_LEVEL_BAR: Record<UsageLimitLevel, string> = {
  normal: 'bg-primary',
  warning: 'bg-yellow-400',
  critical: 'bg-red-500'
}

export const USAGE_LEVEL_TEXT: Record<UsageLimitLevel, string> = {
  normal: 'text-muted-foreground',
  warning: 'text-yellow-500',
  critical: 'text-red-500'
}
