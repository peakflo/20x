import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask, makeAgent } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import { handleRoute, setTaskApiNotifier, stopTaskApiServer } from './task-api-server'

const SECRET_VALUE = 'leaked-secret-value-123456'

let db: DatabaseManager

beforeEach(() => {
  ;({ db } = createTestDb())
})

afterEach(() => {
  setTaskApiNotifier(() => undefined)
  stopTaskApiServer()
})

function createAgentWithSecret() {
  const secret = db.createSecret({
    name: 'My Secret',
    description: '',
    env_var_name: 'MY_SECRET',
    value: SECRET_VALUE
  })!
  const agent = db.createAgent(makeAgent({ config: { secret_ids: [secret.id] } }))!
  return agent
}

describe('/get_messages scrubs persisted secret values', () => {
  it('scrubs tool output and text content before returning them', async () => {
    const agent = createAgentWithSecret()
    const task = db.createTask(makeTask({ title: 'Task with secret agent' }))!
    db.updateTask(task.id, { agent_id: agent.id })

    db.upsertTranscriptParts(task.id, [
      { id: 'p1', role: 'assistant', content: `the key is ${SECRET_VALUE} ok`, partType: 'text' },
      {
        id: 'p2',
        role: 'assistant',
        content: 'Tool completed',
        partType: 'tool',
        tool: { name: 'Bash', output: `result: ${SECRET_VALUE}` }
      }
    ])

    const result = await handleRoute(db, '/get_messages', { task_id: task.id, include_tools: true }) as {
      messages: Array<{ content: string }>
    }

    const joined = JSON.stringify(result.messages)
    expect(joined).not.toContain(SECRET_VALUE)
    expect(joined).toContain('«$MY_SECRET»')
  })

  it('does not scrub (and does not break) when the task has no agent with secrets', async () => {
    const task = db.createTask(makeTask({ title: 'No agent' }))!
    db.upsertTranscriptParts(task.id, [{ id: 'p1', role: 'assistant', content: 'nothing secret here', partType: 'text' }])

    const result = await handleRoute(db, '/get_messages', { task_id: task.id }) as { messages: Array<{ content: string }> }
    expect(result.messages[0].content).toBe('nothing secret here')
  })

  it('still scrubs when the task was reassigned to a different agent than the one that leaked the value', async () => {
    // task's transcript was produced while agent-with-secret was assigned;
    // it's since been reassigned to a plain agent with no secrets of its
    // own. A scrubber scoped to the task's CURRENT agent_id would see no
    // secrets and let the old leak through.
    const leakyAgent = createAgentWithSecret()
    const task = db.createTask(makeTask({ title: 'Reassigned task' }))!
    db.updateTask(task.id, { agent_id: leakyAgent.id })
    db.upsertTranscriptParts(task.id, [
      { id: 'p1', role: 'assistant', content: `the key is ${SECRET_VALUE} ok`, partType: 'text' }
    ])

    const plainAgent = db.createAgent(makeAgent({ config: {} }))!
    db.updateTask(task.id, { agent_id: plainAgent.id })

    const result = await handleRoute(db, '/get_messages', { task_id: task.id }) as { messages: Array<{ content: string }> }
    expect(result.messages[0].content).not.toContain(SECRET_VALUE)
    expect(result.messages[0].content).toContain('«$MY_SECRET»')
  })

  it('still scrubs when the task\'s agent_id no longer resolves to any agent (deleted agent)', async () => {
    const agent = createAgentWithSecret()
    const task = db.createTask(makeTask({ title: 'Orphaned task' }))!
    db.updateTask(task.id, { agent_id: agent.id })
    db.upsertTranscriptParts(task.id, [
      { id: 'p1', role: 'assistant', content: `the key is ${SECRET_VALUE} ok`, partType: 'text' }
    ])

    // tasks.agent_id is ON DELETE SET NULL — deleting the agent row doesn't
    // leave a dangling id, it nulls the column. Either way, a scrubber
    // scoped to the task's (now nonexistent/null) agent_id would see no
    // secrets; the fix is that get_messages no longer scopes to it at all.
    db.deleteAgent(agent.id)
    expect(db.getTask(task.id)?.agent_id).toBeFalsy()

    const result = await handleRoute(db, '/get_messages', { task_id: task.id }) as { messages: Array<{ content: string }> }
    expect(result.messages[0].content).not.toContain(SECRET_VALUE)
  })
})

describe('artifact file writes scrub secret values', () => {
  let workspaceDir: string

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), '20x-task-api-artifact-scrub-'))
    vi.spyOn(db, 'getWorkspaceDir').mockReturnValue(workspaceDir)
  })

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('scrubs a secret value out of write_artifact_file content', async () => {
    const agent = createAgentWithSecret()
    const task = db.createTask(makeTask({ title: 'Artifact task' }))!
    db.updateTask(task.id, { agent_id: agent.id })

    const created = await handleRoute(db, '/create_artifact', { task_id: task.id, title: 'Report', type: 'markdown' }) as {
      artifact: { artifactId: string }
    }

    const written = await handleRoute(db, '/write_artifact_file', {
      task_id: task.id,
      artifact_id: created.artifact.artifactId,
      filename: 'README.md',
      content: `The key is ${SECRET_VALUE}`
    }) as { artifact?: unknown; error?: string }

    expect(written.error).toBeUndefined()

    const read = await handleRoute(db, '/read_artifact_file', {
      task_id: task.id,
      artifact_id: created.artifact.artifactId,
      filename: 'README.md'
    }) as { content: string }

    expect(read.content).not.toContain(SECRET_VALUE)
    expect(read.content).toContain('«$MY_SECRET»')
  })

  it('does not scrub base64-encoded (binary) artifact content', async () => {
    const agent = createAgentWithSecret()
    const task = db.createTask(makeTask({ title: 'Artifact task 2' }))!
    db.updateTask(task.id, { agent_id: agent.id })

    const created = await handleRoute(db, '/create_artifact', { task_id: task.id, title: 'Image', type: 'file' }) as {
      artifact: { artifactId: string }
    }

    const base64Content = Buffer.from(SECRET_VALUE).toString('base64')
    const written = await handleRoute(db, '/write_artifact_file', {
      task_id: task.id,
      artifact_id: created.artifact.artifactId,
      filename: 'data.bin',
      content: base64Content,
      encoding: 'base64'
    }) as { error?: string }
    expect(written.error).toBeUndefined()
  })
})

describe('/create_task and /create_subtask scrub title and description', () => {
  it('scrubs a secret value out of a new task created for an agent that has one', async () => {
    const agent = createAgentWithSecret()

    const result = await handleRoute(db, '/create_task', {
      title: `Rotate key ${SECRET_VALUE}`,
      description: `Current value is ${SECRET_VALUE}`,
      agent_id: agent.id
    }) as { success: boolean; task: { title: string; description: string } }

    expect(result.success).toBe(true)
    expect(result.task.title).not.toContain(SECRET_VALUE)
    expect(result.task.description).not.toContain(SECRET_VALUE)
    expect(result.task.title).toContain('«$MY_SECRET»')
    expect(result.task.description).toContain('«$MY_SECRET»')
  })

  it('scrubs a secret value out of a new subtask created for an agent that has one', async () => {
    const agent = createAgentWithSecret()
    const parent = db.createTask(makeTask({ title: 'Parent' }))!

    const result = await handleRoute(db, '/create_subtask', {
      parent_task_id: parent.id,
      title: `Child task ${SECRET_VALUE}`,
      description: `Uses ${SECRET_VALUE}`,
      agent_id: agent.id
    }) as { success: boolean; task: { title: string; description: string } }

    expect(result.success).toBe(true)
    expect(result.task.title).not.toContain(SECRET_VALUE)
    expect(result.task.description).not.toContain(SECRET_VALUE)
  })

  it('leaves title/description untouched when no agent_id is given (nothing to scrub against)', async () => {
    const result = await handleRoute(db, '/create_task', {
      title: `No agent ${SECRET_VALUE}`,
      description: 'plain'
    }) as { success: boolean; task: { title: string } }

    expect(result.success).toBe(true)
    // No agent_id means no scrubber is available — the value isn't a known
    // secret from 20x's point of view, so it passes through unchanged.
    expect(result.task.title).toContain(SECRET_VALUE)
  })

  it('scrubs a secret value out of a new subtask\'s output_fields', async () => {
    const agent = createAgentWithSecret()
    const parent = db.createTask(makeTask({ title: 'Parent' }))!

    const result = await handleRoute(db, '/create_subtask', {
      parent_task_id: parent.id,
      title: 'Child task',
      agent_id: agent.id,
      output_fields: [{ name: 'summary', value: `Found ${SECRET_VALUE} in config` }]
    }) as { success: boolean; task: { output_fields: Array<{ value: string }> } }

    expect(result.success).toBe(true)
    expect(result.task.output_fields[0].value).not.toContain(SECRET_VALUE)
    expect(result.task.output_fields[0].value).toContain('«$MY_SECRET»')
  })
})

describe('/update_task scrubs title, description, and output_fields', () => {
  it('scrubs a secret value out of output_fields before persisting', async () => {
    const agent = createAgentWithSecret()
    const task = db.createTask(makeTask({ title: 'Output fields task' }))!
    db.updateTask(task.id, { agent_id: agent.id })

    const result = await handleRoute(db, '/update_task', {
      task_id: task.id,
      output_fields: [{ name: 'summary', value: `Found ${SECRET_VALUE} in config` }]
    }) as { success: boolean; task: { output_fields: Array<{ value: string }> } }

    expect(result.success).toBe(true)
    expect(result.task.output_fields[0].value).not.toContain(SECRET_VALUE)
    expect(result.task.output_fields[0].value).toContain('«$MY_SECRET»')
  })

  it('scrubs a secret value out of title and description before persisting', async () => {
    const agent = createAgentWithSecret()
    const task = db.createTask(makeTask({ title: 'Original title' }))!
    db.updateTask(task.id, { agent_id: agent.id })

    const result = await handleRoute(db, '/update_task', {
      task_id: task.id,
      title: `Rotate key ${SECRET_VALUE}`,
      description: `Current value is ${SECRET_VALUE}`
    }) as { success: boolean; task: { title: string; description: string } }

    expect(result.success).toBe(true)
    expect(result.task.title).not.toContain(SECRET_VALUE)
    expect(result.task.description).not.toContain(SECRET_VALUE)
    expect(result.task.title).toContain('«$MY_SECRET»')
    expect(result.task.description).toContain('«$MY_SECRET»')
  })
})
