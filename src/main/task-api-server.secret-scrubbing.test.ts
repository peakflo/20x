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
