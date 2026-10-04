/**
 * Pure normalizers that turn provider payloads into context-window figures
 * (`ContextUsageReport` fields). Kept free of Electron / DB imports so they can
 * be unit-tested in isolation. Inputs are loosely typed: they come from external
 * runtimes whose shapes evolve independently of this app.
 */

const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000
const CLAUDE_1M_CONTEXT_WINDOW = 1_000_000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

// ── Claude Code ─────────────────────────────────────────────

/**
 * Context tokens occupied after a main-loop assistant message: everything the
 * request carried (fresh input, cache reads and writes) plus the reply itself.
 * Null when the message has no usable usage block.
 */
export function claudeAssistantContextTokens(message: unknown): number | null {
  if (!isObject(message) || !isObject(message.message)) return null
  const usage = message.message.usage
  if (!isObject(usage)) return null
  const total =
    num(usage.input_tokens) +
    num(usage.cache_read_input_tokens) +
    num(usage.cache_creation_input_tokens) +
    num(usage.output_tokens)
  return total > 0 ? total : null
}

/** `result.modelUsage[*].contextWindow`, keyed by model id. Models without a window are omitted. */
export function claudeContextWindowsFromModelUsage(modelUsage: unknown): Record<string, number> {
  const windows: Record<string, number> = {}
  if (!isObject(modelUsage)) return windows
  for (const [model, raw] of Object.entries(modelUsage)) {
    const window = isObject(raw) ? optionalNumber(raw.contextWindow) : null
    if (model && window) windows[model] = window
  }
  return windows
}

/** Window size used when the SDK has not reported one for the model yet. */
export function claudeFallbackContextWindow(model: string | null | undefined): number {
  return model && model.includes('[1m]') ? CLAUDE_1M_CONTEXT_WINDOW : DEFAULT_CLAUDE_CONTEXT_WINDOW
}

/** `system/compact_boundary` → tokens left in the context after compaction. */
export function claudeCompactBoundaryTokens(message: unknown): number | null {
  if (!isObject(message) || !isObject(message.compact_metadata)) return null
  return optionalNumber(message.compact_metadata.post_tokens)
}

// ── Codex app-server ────────────────────────────────────────

/**
 * `thread/tokenUsage/updated` → the last model call's context size and the
 * model's window. `last` is per-call, so it reflects what the window holds now.
 */
export function codexContextUsageFromTokenUsage(params: unknown): {
  usedTokens: number | null
  maxTokens: number | null
} | null {
  if (!isObject(params) || !isObject(params.tokenUsage)) return null
  const tokenUsage = params.tokenUsage
  const last = isObject(tokenUsage.last) ? tokenUsage.last : null
  let usedTokens = last ? optionalNumber(last.totalTokens) : null
  if (usedTokens === null && last) {
    const fallback = num(last.inputTokens) + num(last.outputTokens)
    usedTokens = fallback > 0 ? fallback : null
  }
  const maxTokens = optionalNumber(tokenUsage.modelContextWindow)
  if (usedTokens === null && maxTokens === null) return null
  return { usedTokens, maxTokens }
}

// ── Cursor (ACP) ────────────────────────────────────────────

/** ACP `session/update` `usage_update` → context occupancy (`used`) and window size (`size`). */
export function acpUsageUpdateContextUsage(update: unknown): { usedTokens: number; maxTokens: number } | null {
  if (!isObject(update)) return null
  const used = update.used
  const size = update.size
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null
  return { usedTokens: used, maxTokens: size }
}
