import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))

/**
 * These tests verify that the update_own_task tool schema in both .ts and .js
 * files includes all required fields. The triaging agent needs agent_id, repos,
 * skill_ids, output_fields, and priority to fully configure tasks.
 */
describe('update_own_task schema', () => {
  const requiredFields = ['agent_id', 'repos', 'skill_ids', 'output_fields', 'priority']

  for (const ext of ['ts', 'js']) {
    describe(`task-management-mcp.${ext}`, () => {
      const filePath = resolve(__dir, `task-management-mcp.${ext}`)
      const source = readFileSync(filePath, 'utf-8')

      // Extract the update_own_task tool definition block
      const toolStart = source.indexOf("name: 'update_own_task'")
      expect(toolStart).toBeGreaterThan(-1)

      // Find the end of this tool definition (next tool or end of array)
      const afterTool = source.indexOf("name: 'update_sibling_task'", toolStart)
      const toolBlock = source.slice(toolStart, afterTool > -1 ? afterTool : toolStart + 2000)

      for (const field of requiredFields) {
        it(`includes ${field} in ${ext} file`, () => {
          expect(toolBlock).toContain(field)
        })
      }
    })
  }
})

describe('artifact workpiece tool schemas', () => {
  const toolNames = [
    'create_artifact',
    'list_artifacts',
    'read_artifact_file',
    'write_artifact_file',
    'edit_artifact_file'
  ]

  for (const ext of ['ts', 'js']) {
    it(`keeps the complete explicit artifact tool set in ${ext}`, () => {
      const source = readFileSync(resolve(__dir, `task-management-mcp.${ext}`), 'utf-8')
      for (const toolName of toolNames) expect(source).toContain(`name: '${toolName}'`)
      expect(source).toContain('TASK_ARTIFACT_SCOPE_ID')
    })
  }
})
