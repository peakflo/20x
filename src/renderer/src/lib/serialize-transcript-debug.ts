import type { AgentMessage } from '@/stores/agent-store'
import { SessionStatus } from '@/stores/agent-store'

/** Maximum number of recent UI messages to include */
const MAX_UI_MESSAGES = 50

/** Maximum characters per tool input/output field */
const MAX_TOOL_CONTENT = 2000

/** Raw transcript part from the coding agent backend */
export interface RawTranscriptPart {
  type: string
  content?: string
  tool?: {
    name: string
    status?: string
    input?: string
    output?: string
    error?: string
  }
}

/** Raw transcript message from the coding agent backend */
export interface RawTranscriptMessage {
  role: string
  parts: RawTranscriptPart[]
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + `\n… (truncated, ${str.length - max} more chars)`
}

function formatTimestamp(date: Date): string {
  return date.toISOString()
}

function serializeToolInfo(tool: NonNullable<AgentMessage['tool']>): string {
  const lines: string[] = []
  lines.push(`    tool: ${tool.name} [${tool.status}]`)
  if (tool.title) lines.push(`    title: ${tool.title}`)
  if (tool.input) lines.push(`    input: ${truncate(String(tool.input), MAX_TOOL_CONTENT)}`)
  if (tool.output) lines.push(`    output: ${truncate(String(tool.output), MAX_TOOL_CONTENT)}`)
  if (tool.error) lines.push(`    error: ${tool.error}`)
  if (tool.questions?.length) {
    lines.push(`    questions: ${JSON.stringify(tool.questions)}`)
  }
  if (tool.todos?.length) {
    const summary = tool.todos.map(t => `[${t.status}] ${t.content}`).join('; ')
    lines.push(`    todos: ${summary}`)
  }
  return lines.join('\n')
}

function serializeMessage(msg: AgentMessage, index: number): string {
  const lines: string[] = []
  const ts = formatTimestamp(msg.timestamp)
  const partLabel = msg.partType ? ` (${msg.partType})` : ''
  lines.push(`[${index}] ${ts} ${msg.role}${partLabel}`)

  if (msg.content) {
    lines.push(`  ${truncate(msg.content, MAX_TOOL_CONTENT)}`)
  }

  if (msg.tool) {
    lines.push(serializeToolInfo(msg.tool))
  }

  if (msg.taskProgress) {
    const tp = msg.taskProgress
    lines.push(`    taskProgress: ${tp.status} — ${tp.description}`)
    if (tp.lastToolName) lines.push(`    lastTool: ${tp.lastToolName}`)
    if (tp.summary) lines.push(`    summary: ${truncate(tp.summary, 500)}`)
    if (tp.usage) {
      lines.push(`    usage: ${tp.usage.tool_uses} tools, ${tp.usage.total_tokens} tokens, ${tp.usage.duration_ms}ms`)
    }
  }

  if (msg.stepMeta) {
    const parts: string[] = []
    if (msg.stepMeta.durationMs != null) parts.push(`${(msg.stepMeta.durationMs / 1000).toFixed(1)}s`)
    if (msg.stepMeta.tokens) {
      const t = msg.stepMeta.tokens
      parts.push(`in:${t.input} out:${t.output} cache:${t.cache}`)
    }
    if (parts.length) lines.push(`    step: ${parts.join(' · ')}`)
  }

  return lines.join('\n')
}

// ── Raw transcript serializer ──

function serializeRawPart(part: RawTranscriptPart): string {
  const lines: string[] = []
  lines.push(`    [${part.type}]`)
  if (part.content) {
    lines.push(`      ${part.content}`)
  }
  if (part.tool) {
    lines.push(`      tool: ${part.tool.name}${part.tool.status ? ` [${part.tool.status}]` : ''}`)
    if (part.tool.input) lines.push(`      input: ${part.tool.input}`)
    if (part.tool.output) lines.push(`      output: ${part.tool.output}`)
    if (part.tool.error) lines.push(`      error: ${part.tool.error}`)
  }
  return lines.join('\n')
}

function serializeRawMessage(msg: RawTranscriptMessage, index: number): string {
  const lines: string[] = []
  lines.push(`  [${index}] ${msg.role}`)
  for (const part of msg.parts) {
    lines.push(serializeRawPart(part))
  }
  return lines.join('\n')
}

export interface TranscriptDebugInfo {
  sessionId?: string | null
  taskId?: string
  agentId?: string
  status: SessionStatus
  systemStatus?: string | null
  messageCount: number
}

/**
 * Serializes recent transcript messages into a structured debug string
 * suitable for clipboard copy and sharing for debugging purposes.
 * Includes both UI-level messages and raw coding agent output when available.
 */
export function serializeTranscriptForDebug(
  messages: AgentMessage[],
  info: TranscriptDebugInfo,
  rawTranscript?: RawTranscriptMessage[]
): string {
  const header = [
    '=== Agent Transcript Debug ===',
    `Timestamp: ${new Date().toISOString()}`,
    `Session: ${info.sessionId || '(none)'}`,
    info.taskId ? `Task: ${info.taskId}` : null,
    info.agentId ? `Agent: ${info.agentId}` : null,
    `Status: ${info.status}`,
    info.systemStatus ? `System Status: ${info.systemStatus}` : null,
    `Total Messages: ${info.messageCount}`,
  ].filter(Boolean).join('\n')

  // ── UI Messages Section ──
  const recent = messages.slice(-MAX_UI_MESSAGES)
  const skipped = messages.length - recent.length
  const uiBody = recent.map((msg, i) => serializeMessage(msg, skipped + i)).join('\n\n')

  const sections = [header]

  // UI messages
  sections.push('')
  sections.push('--- UI Messages (processed) ---')
  if (skipped > 0) {
    sections.push(`… (${skipped} earlier messages omitted)`)
  }
  sections.push(uiBody)

  // ── Raw Transcript Section ──
  if (rawTranscript && rawTranscript.length > 0) {
    sections.push('')
    sections.push(`--- Raw Agent Transcript (${rawTranscript.length} messages) ---`)
    const rawBody = rawTranscript.map((msg, i) => serializeRawMessage(msg, i)).join('\n\n')
    sections.push(rawBody)
  }

  sections.push('')
  sections.push('=== End Debug ===')

  return sections.join('\n')
}
