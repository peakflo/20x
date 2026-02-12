import type { OutputFieldRecord } from './database'

interface MessagePart {
  type: string
  text?: string
  tool?: string
  state?: { status?: string; input?: Record<string, string> }
}

interface AgentMessage {
  info?: { role?: string }
  parts?: MessagePart[]
}

/**
 * Extracts the last JSON code block from text.
 * Searches for ```json first, then any ``` block.
 */
export function extractJsonBlock(text: string): Record<string, unknown> | null {
  // Find the LAST json code block (greedy outer match)
  const jsonBlocks = [...text.matchAll(/```json\s*\n?([\s\S]*?)\n?\s*```/g)]
  const plainBlocks = [...text.matchAll(/```\s*\n?([\s\S]*?)\n?\s*```/g)]

  const match = jsonBlocks.length > 0
    ? jsonBlocks[jsonBlocks.length - 1]
    : plainBlocks.length > 0
      ? plainBlocks[plainBlocks.length - 1]
      : null

  if (!match) return null

  const raw = match[1].trim()
  try {
    return JSON.parse(raw)
  } catch {
    return extractPartialJson(raw)
  }
}

/**
 * Extracts complete key-value pairs from truncated JSON.
 */
export function extractPartialJson(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const stringPairs = raw.matchAll(/"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)
  for (const m of stringPairs) {
    result[m[1]] = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  const literalPairs = raw.matchAll(/"([^"]+)"\s*:\s*(true|false|null|-?\d+(?:\.\d+)?)\s*[,}\n]/g)
  for (const m of literalPairs) {
    result[m[1]] = JSON.parse(m[2])
  }
  return result
}

/**
 * Collects file paths from completed write/edit tool calls.
 */
export function collectWrittenFiles(messages: AgentMessage[]): string[] {
  const files: string[] = []
  for (const msg of messages) {
    if (!msg.parts) continue
    for (const part of msg.parts) {
      if (part.type !== 'tool' || part.state?.status !== 'completed') continue
      const toolName = (part.tool || '').toLowerCase()
      if (toolName === 'write' || toolName === 'edit' || toolName === 'create_file') {
        const input = part.state?.input || {}
        const filePath = input.file_path || input.path || input.filename
        if (filePath) files.push(filePath)
      }
    }
  }
  return files
}

/**
 * Extracts output field values from agent messages.
 * Returns updated fields with values filled in, or null if no values found.
 */
export function extractOutputFromMessages(
  messages: AgentMessage[],
  fields: OutputFieldRecord[]
): OutputFieldRecord[] | null {
  const assistantMessages = messages.filter((m) => m.info?.role === 'assistant')
  if (assistantMessages.length === 0) return null

  const writtenFiles = collectWrittenFiles(assistantMessages)
  let parsedValues: Record<string, unknown> = {}

  // Search last assistant message first, then earlier ones
  for (let i = assistantMessages.length - 1; i >= 0; i--) {
    const msg = assistantMessages[i]
    if (!msg.parts) continue
    const fullText = msg.parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('\n')
    if (!fullText) continue

    const extracted = extractJsonBlock(fullText)
    if (extracted && Object.keys(extracted).length > 0) {
      parsedValues = extracted
      break
    }
  }

  if (Object.keys(parsedValues).length === 0 && writtenFiles.length === 0) return null

  // Build lookup maps
  const byName = new Map<string, unknown>()
  const byId = new Map<string, unknown>()
  for (const [key, value] of Object.entries(parsedValues)) {
    byId.set(key, value)
    byName.set(key.toLowerCase(), value)
  }

  return fields.map((field) => {
    const updated = { ...field }
    const valueByName = byName.get(field.name.toLowerCase())
    const valueById = byId.get(field.id)
    if (valueByName !== undefined) {
      updated.value = valueByName
    } else if (valueById !== undefined) {
      updated.value = valueById
    }
    if (field.type === 'file' && !updated.value && writtenFiles.length > 0) {
      updated.value = field.multiple ? writtenFiles : writtenFiles[0]
    }
    return updated
  })
}
