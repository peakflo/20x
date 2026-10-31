export interface InlineHtmlChoice {
  sourceMessageId: string
  action?: string
  data?: Record<string, unknown>
}

export function validInlineHtmlChoice(text: string, choice: InlineHtmlChoice): boolean {
  if (!text || text !== text.trim() || text.length > 2000 || /[<>\u0000-\u001f]/.test(text)) return false
  if (!choice || typeof choice.sourceMessageId !== 'string' || !choice.sourceMessageId || choice.sourceMessageId.length > 255) return false
  if (choice.action !== undefined && !/^[a-z][a-z0-9._-]{0,79}$/.test(choice.action)) return false
  if (choice.data !== undefined && (!choice.data || typeof choice.data !== 'object' || Array.isArray(choice.data))) return false
  try { return new TextEncoder().encode(JSON.stringify(choice)).length <= 4096 } catch { return false }
}

export function parseInlineHtmlChoice(value: unknown): { text: string; action?: string; data?: Record<string, unknown> } | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (row.type !== 'workflo-inline-send' || typeof row.text !== 'string') return null
  if (!row.text || row.text !== row.text.trim() || row.text.length > 2000 || /[<>\u0000-\u001f]/.test(row.text)) return null
  const options = row.options
  if (options === undefined) return { text: row.text }
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null
  const parsed = options as Record<string, unknown>
  if (Object.keys(parsed).some((key) => key !== 'action' && key !== 'data')) return null
  if (parsed.action !== undefined && (typeof parsed.action !== 'string' || !/^[a-z][a-z0-9._-]{0,79}$/.test(parsed.action))) return null
  if (parsed.data !== undefined && (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data))) return null
  try { if (new TextEncoder().encode(JSON.stringify(parsed)).length > 4096) return null } catch { return null }
  return { text: row.text, ...(parsed.action ? { action: parsed.action as string } : {}),
    ...(parsed.data ? { data: parsed.data as Record<string, unknown> } : {}) }
}
