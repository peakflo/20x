export const CODEX_REASONING_EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export const CLAUDE_REASONING_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const REASONING_EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export type ReasoningEffort = typeof REASONING_EFFORT_VALUES[number]

const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORT_VALUES)

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORT_SET.has(value)
}

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return isReasoningEffort(value) ? value : undefined
}
