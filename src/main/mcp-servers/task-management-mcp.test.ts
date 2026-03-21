import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dir, 'task-management-mcp.ts'), 'utf-8')

/**
 * Extract enum arrays from MCP tool schema definitions in the source.
 * Matches patterns like: status: { type: 'string', enum: ['a', 'b', 'c'] ... }
 */
function extractStatusEnums(src: string): { toolName: string; statuses: string[] }[] {
  const results: { toolName: string; statuses: string[] }[] = []

  // Find each tool definition block and its status enum
  const toolNameRegex = /name:\s*'(\w+)'/g
  const statusEnumRegex = /status:\s*\{[^}]*enum:\s*\[([^\]]+)\]/g

  let toolMatch: RegExpExecArray | null
  const toolPositions: { name: string; pos: number }[] = []
  while ((toolMatch = toolNameRegex.exec(src)) !== null) {
    toolPositions.push({ name: toolMatch[1], pos: toolMatch.index })
  }

  let statusMatch: RegExpExecArray | null
  while ((statusMatch = statusEnumRegex.exec(src)) !== null) {
    const pos = statusMatch.index
    // Find which tool this status enum belongs to
    let ownerTool = 'unknown'
    for (let i = toolPositions.length - 1; i >= 0; i--) {
      if (toolPositions[i].pos < pos) {
        ownerTool = toolPositions[i].name
        break
      }
    }
    const statuses = statusMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/'/g, ''))
      .filter(Boolean)
    results.push({ toolName: ownerTool, statuses })
  }

  return results
}

describe('task-management-mcp schema consistency', () => {
  it('subtask update_own_task uses the same status enum as main task update_task', () => {
    const enums = extractStatusEnums(source)

    const updateTask = enums.find((e) => e.toolName === 'update_task')
    const updateOwnTask = enums.find((e) => e.toolName === 'update_own_task')

    expect(updateTask).toBeDefined()
    expect(updateOwnTask).toBeDefined()

    expect(updateOwnTask!.statuses).toEqual(updateTask!.statuses)
  })

  it('subtask status enum does not use values outside the main task status enum', () => {
    const enums = extractStatusEnums(source)

    const updateTask = enums.find((e) => e.toolName === 'update_task')
    const updateOwnTask = enums.find((e) => e.toolName === 'update_own_task')

    expect(updateTask).toBeDefined()
    expect(updateOwnTask).toBeDefined()

    const mainStatuses = new Set(updateTask!.statuses)
    for (const status of updateOwnTask!.statuses) {
      expect(mainStatuses.has(status)).toBe(true)
    }
  })

  it('blocked statuses validation prevents subtasks from self-completing or self-cancelling', () => {
    // Verify the source still contains the blocked statuses guard
    expect(source).toContain("const blockedStatuses = ['completed', 'cancelled']")
    expect(source).toContain('Subtasks cannot set status to')
  })
})
