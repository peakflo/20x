import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { safeStorage } from 'electron'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask, makeAgent } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'
import { handleRoute, setTaskApiNotifier, stopTaskApiServer } from './task-api-server'

const SECRET_VALUE = 'leaked-secret-value-123456'

let db: DatabaseManager

beforeEach(() => {
  ;({ db } = createTestDb())
  // These tests exercise createSecret, which refuses to save when
  // safeStorage reports encryption unavailable (the default test mock) —
  // see secret-storage-refusal.test.ts for that behavior itself.
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
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

  // Minor finding, re-review: get_messages used to page the RAW tool output
  // (via toolOutputPage, which slices at a fixed character offset) BEFORE
  // scrubbing, so a secret straddling the page boundary split into two
  // halves, neither of which matched the scrubber's literal-substring
  // search — leaking both halves across two page fetches. Scrubbing the
  // FULL output once, before paging, closes this: by the time paging runs,
  // the secret is already gone, so no boundary can split it.
  it('scrubs a secret even when it straddles the output pagination boundary', async () => {
    const agent = createAgentWithSecret()
    const task = db.createTask(makeTask({ title: 'Boundary task' }))!
    db.updateTask(task.id, { agent_id: agent.id })

    // TOOL_OUTPUT_PAGE_CHARS is 20_000 — place the secret exactly straddling
    // that boundary, split precisely in half, so each raw half ends up on a
    // different page under the OLD (page-before-scrub) behavior.
    const half = Math.floor(SECRET_VALUE.length / 2)
    const firstHalf = SECRET_VALUE.slice(0, half)
    const secondHalf = SECRET_VALUE.slice(half)
    const before = 'x'.repeat(20_000 - half)
    const after = 'y'.repeat(50)
    db.upsertTranscriptParts(task.id, [
      {
        id: 'p1',
        role: 'assistant',
        content: 'Tool completed',
        partType: 'tool',
        tool: { name: 'Bash', output: `${before}${SECRET_VALUE}${after}` }
      }
    ])

    const page1 = await handleRoute(db, '/get_messages', { task_id: task.id, include_tools: true }) as {
      messages: Array<{ content: string; output_next_offset?: number }>
    }
    expect(page1.messages[0].content).not.toContain(SECRET_VALUE)
    // Neither half of the secret leaks either — under the OLD bug, page 1's
    // raw slice ends exactly at the boundary, so it WOULD contain this
    // first half as a plain, unredacted substring.
    expect(page1.messages[0].content).not.toContain(firstHalf)

    const nextOffset = page1.messages[0].output_next_offset
    expect(nextOffset).toBeDefined()
    const page2 = await handleRoute(db, '/get_messages', {
      task_id: task.id,
      include_tools: true,
      output_offset: nextOffset
    }) as { messages: Array<{ content: string }> }
    expect(page2.messages[0].content).not.toContain(SECRET_VALUE)
    // Under the OLD bug, page 2's raw slice starts exactly at the boundary,
    // so it WOULD contain this second half as a plain, unredacted substring.
    expect(page2.messages[0].content).not.toContain(secondHalf)
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

  // Major finding, re-review: create_task/create_subtask used to scrub
  // against the NEW row's TARGET agent_id — but the text being scrubbed is
  // the CALLING agent's own writing (an agent creating a sibling/follow-up
  // task), and the target is very often a DIFFERENT agent (or none yet).
  // Scrubbing against the target's secrets missed the actual leak whenever
  // caller and target differ, which is the common case for a task handed
  // off between agents.
  it("scrubs the CALLER's secret even when the new task is assigned to a DIFFERENT agent that has no secrets of its own", async () => {
    const callerAgentWithSecret = createAgentWithSecret()
    const targetAgentNoSecrets = db.createAgent(makeAgent({ config: {} }))!
    expect(callerAgentWithSecret.id).not.toBe(targetAgentNoSecrets.id)

    const result = await handleRoute(db, '/create_task', {
      title: `Rotate key ${SECRET_VALUE}`,
      description: `Current value is ${SECRET_VALUE}`,
      // Assigned to the agent with NO secrets — a scrubber scoped to this
      // target would see nothing and let the caller's leaked value through.
      agent_id: targetAgentNoSecrets.id
    }) as { success: boolean; task: { title: string; description: string } }

    expect(result.success).toBe(true)
    expect(result.task.title).not.toContain(SECRET_VALUE)
    expect(result.task.description).not.toContain(SECRET_VALUE)
    expect(result.task.title).toContain('«$MY_SECRET»')
  })

  it("scrubs a subtask's output_fields against the global secret set even when its target agent has none of its own", async () => {
    createAgentWithSecret() // some OTHER agent in the system has the secret
    const targetAgentNoSecrets = db.createAgent(makeAgent({ config: {} }))!
    const parent = db.createTask(makeTask({ title: 'Parent' }))!

    const result = await handleRoute(db, '/create_subtask', {
      parent_task_id: parent.id,
      title: 'Child task',
      agent_id: targetAgentNoSecrets.id,
      output_fields: [{ name: 'summary', value: `Found ${SECRET_VALUE} in config` }]
    }) as { success: boolean; task: { output_fields: Array<{ value: string }> } }

    expect(result.success).toBe(true)
    expect(result.task.output_fields[0].value).not.toContain(SECRET_VALUE)
    expect(result.task.output_fields[0].value).toContain('«$MY_SECRET»')
  })

  it('leaves title/description untouched when this installation has no secrets registered anywhere (nothing to scrub against)', async () => {
    const result = await handleRoute(db, '/create_task', {
      title: `No agent ${SECRET_VALUE}`,
      description: 'plain'
    }) as { success: boolean; task: { title: string } }

    expect(result.success).toBe(true)
    // Scrubbing is against the GLOBAL secret set now, not `agent_id` — this
    // test has no agent_id AND no secret created anywhere in the DB, so
    // there's genuinely nothing to scrub against either way. The value
    // isn't a known
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
