/**
 * Schema guarantees for the task-management tool set.
 *
 * These tests used to read the source text of two hand-maintained copies of the
 * server, a .ts and a .js, and grep them for field names. There is now one
 * source, so the schemas are checked as data instead.
 */
import { describe, it, expect } from 'vitest'
import {
  FULL_ACCESS_SCOPE,
  callToolForScope,
  listToolsForScope,
  type TaskMcpScope
} from './task-management-core'

const SCOPED: TaskMcpScope = {
  parentTaskId: 'task-parent',
  taskId: 'task-own',
  artifactTaskId: 'task-own'
}

const toolByName = (scope: TaskMcpScope, name: string) =>
  listToolsForScope(scope).find((tool) => tool.name === name)

const propertiesOf = (scope: TaskMcpScope, name: string): Record<string, unknown> => {
  const tool = toolByName(scope, name)
  expect(tool, `tool ${name} must exist`).toBeDefined()
  return (tool!.inputSchema.properties ?? {}) as Record<string, unknown>
}

describe('update_own_task schema', () => {
  // The triaging agent needs these to fully configure a task.
  const requiredFields = ['agent_id', 'repos', 'skill_ids', 'output_fields', 'priority']

  for (const field of requiredFields) {
    it(`accepts ${field}`, () => {
      expect(Object.keys(propertiesOf(SCOPED, 'update_own_task'))).toContain(field)
    })
  }
})

describe('artifact workpiece tools', () => {
  const toolNames = [
    'create_artifact',
    'list_artifacts',
    'read_artifact_file',
    'write_artifact_file',
    'edit_artifact_file'
  ]

  it('are available to a full-access session', () => {
    const names = listToolsForScope(FULL_ACCESS_SCOPE).map((t) => t.name)
    for (const name of toolNames) expect(names).toContain(name)
  })

  it('are available to a scoped subtask session', () => {
    const names = listToolsForScope(SCOPED).map((t) => t.name)
    for (const name of toolNames) expect(names).toContain(name)
  })

  it('are pinned to the task that owns them, whatever task the agent names', async () => {
    const calls: Array<{ route: string; params: Record<string, unknown> }> = []
    const invoke = async (route: string, params: Record<string, unknown>): Promise<unknown> => {
      calls.push({ route, params })
      return { ok: true }
    }

    await callToolForScope(
      'write_artifact_file',
      { task_id: 'some-other-task', artifact_id: 'a1', path: 'index.md', content: 'x' },
      { parentTaskId: null, taskId: null, artifactTaskId: 'task-owner' },
      invoke
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].params.task_id).toBe('task-owner')
  })
})

describe('tool sets per scope', () => {
  it('gives a full-access session the orchestration tools and no scoped aliases', () => {
    const names = listToolsForScope(FULL_ACCESS_SCOPE).map((t) => t.name)
    expect(names).toContain('list_tasks')
    expect(names).toContain('create_task')
    expect(names).not.toContain('get_own_task')
  })

  it('gives a subtask session only its own neighbourhood', () => {
    const names = listToolsForScope(SCOPED).map((t) => t.name)
    expect(names).toContain('get_own_task')
    expect(names).toContain('get_parent_task')
    expect(names).toContain('update_own_task')
    expect(names).not.toContain('list_tasks')
    expect(names).not.toContain('create_task')
  })

  it('never advertises the same tool twice', () => {
    for (const scope of [FULL_ACCESS_SCOPE, SCOPED]) {
      const names = listToolsForScope(scope).map((t) => t.name)
      expect(names).toHaveLength(new Set(names).size)
    }
  })

  it('gives every tool a description and an object input schema', () => {
    for (const scope of [FULL_ACCESS_SCOPE, SCOPED]) {
      for (const tool of listToolsForScope(scope)) {
        expect(tool.description, `${tool.name} needs a description`).toBeTruthy()
        expect(tool.inputSchema.type, `${tool.name} needs an object schema`).toBe('object')
      }
    }
  })
})

describe('subtask status ceiling', () => {
  it('refuses a self-completion and points at ready_for_review', async () => {
    const invoke = async (): Promise<unknown> => ({ ok: true })

    for (const status of ['completed', 'cancelled']) {
      const result = await callToolForScope('update_own_task', { status }, SCOPED, invoke)
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('ready_for_review')
    }
  })
})
