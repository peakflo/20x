import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleRoute, setTaskApiAgentController, setTaskApiUiState } from './task-api-server'

/** The routes take the database first; the tests read better the other way. */
const handleTaskApiRoute = (
  route: string,
  params: Record<string, unknown>,
  db: unknown
): Promise<unknown> => handleRoute(db as never, route, params)
import type { TaskRecord } from './database'

/**
 * The tools an agent needs to control 20x by voice.
 *
 * The rule these tests protect: a task row cannot answer "is this waiting for
 * me?". `waiting_approval` is a session state and is never written to the task
 * record, so a blocked task looks exactly like a running one in `get_task`.
 */

function task(id: string, title: string, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title,
    description: '',
    type: 'general',
    priority: 'medium',
    status: 'agent_working',
    assignee: '',
    due_date: null,
    labels: [],
    attachments: [],
    repos: [],
    output_fields: [],
    agent_id: 'a1',
    external_id: null,
    source_id: null,
    source: 'local',
    skill_ids: null,
    session_id: null,
    snoozed_until: null,
    resolution: null,
    feedback_rating: null,
    feedback_comment: null,
    is_recurring: false,
    recurrence_pattern: null,
    recurrence_parent_id: null,
    last_occurrence_at: null,
    next_occurrence_at: null,
    heartbeat_enabled: false,
    heartbeat_interval_minutes: null,
    heartbeat_last_check_at: null,
    heartbeat_next_check_at: null,
    auto_start_agent: false,
    auto_complete_without_review: false,
    parent_task_id: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...extra,
  } as TaskRecord
}

const TASKS = [task('t1', 'Fix login'), task('t2', 'Write the release notes')]

function part(seq: number, role: string, content: string, partType = 'text') {
  return {
    taskId: 't1',
    partId: `p${seq}`,
    seq,
    role,
    content,
    partType,
    createdAt: 1_700_000_000_000 + seq * 1000,
    updatedAt: 1_700_000_000_000 + seq * 1000,
    rev: seq,
  }
}

const PARTS = [
  part(1, 'user', 'why did the test fail'),
  part(2, 'assistant', 'I am looking at it'),
  part(3, 'assistant', '{"tool":"bash","output":"…10 kB of log…"}', 'tool'),
  part(4, 'assistant', 'The mock was missing'),
]

function makeDb() {
  return {
    getTasks: vi.fn(() => TASKS),
    getTask: vi.fn((id: string) => TASKS.find((t) => t.id === id)),
    getTranscriptParts: vi.fn(() => PARTS),
  } as never
}

function makeAgents(overrides: Record<string, unknown> = {}) {
  return {
    startTask: vi.fn(),
    notifyParentOfSubtaskCompletion: vi.fn(),
    sendByTaskId: vi.fn(async () => ({ sessionId: 's1' })),
    respondToPermission: vi.fn(async () => undefined),
    stopByTaskId: vi.fn(async () => ({ sessionId: 's1' })),
    findSessionByTaskId: vi.fn((id: string) =>
      id === 't1' ? { sessionId: 's1', session: {} } : undefined
    ),
    getSessionStatus: vi.fn(() => ({ status: 'waiting_approval', agentId: 'a1', taskId: 't1' })),
    getActiveSessionsForTask: vi.fn(() => ['s1']),
    ...overrides,
  }
}

let agents: ReturnType<typeof makeAgents>

beforeEach(() => {
  agents = makeAgents()
  setTaskApiAgentController(agents as never)
  setTaskApiUiState(null)
})

describe('get_messages', () => {
  it('returns the conversation newest first and leaves tool output out', async () => {
    const result = (await handleTaskApiRoute('/get_messages', { task_id: 't1' }, makeDb())) as {
      messages: Array<{ seq: number; content: string }>
    }
    expect(result.messages.map((m) => m.seq)).toEqual([4, 2, 1])
    // A transcript full of tool JSON would drown the reply.
    expect(JSON.stringify(result.messages)).not.toContain('10 kB of log')
  })

  it('includes tool output when it is asked for', async () => {
    const result = (await handleTaskApiRoute(
      '/get_messages',
      { task_id: 't1', include_tools: true },
      makeDb()
    )) as { messages: Array<{ seq: number }> }
    expect(result.messages.map((m) => m.seq)).toEqual([4, 3, 2, 1])
  })

  it('pages backwards with the cursor it returns', async () => {
    const db = makeDb()
    const first = (await handleTaskApiRoute('/get_messages', { task_id: 't1', limit: 2 }, db)) as {
      messages: Array<{ seq: number }>
      next_before_seq: number | null
    }
    expect(first.messages.map((m) => m.seq)).toEqual([4, 2])
    expect(first.next_before_seq).toBe(2)

    const second = (await handleTaskApiRoute(
      '/get_messages',
      { task_id: 't1', limit: 2, before_seq: first.next_before_seq },
      db
    )) as { messages: Array<{ seq: number }>; next_before_seq: number | null }
    expect(second.messages.map((m) => m.seq)).toEqual([1])
    expect(second.next_before_seq).toBeNull()
  })

  it('returns one side of the conversation on request', async () => {
    const result = (await handleTaskApiRoute(
      '/get_messages',
      { task_id: 't1', role: 'user' },
      makeDb()
    )) as { messages: Array<{ role: string }> }
    expect(result.messages.every((m) => m.role === 'user')).toBe(true)
  })
})

describe('get_session_status', () => {
  it('reports the live state that the task record cannot hold', async () => {
    const result = (await handleTaskApiRoute('/get_session_status', { task_id: 't1' }, makeDb())) as {
      task_status: string
      session_status: string
      waiting_for_you: boolean
    }
    // The stored status says the agent is working; only the session knows it
    // is blocked on the user.
    expect(result.task_status).toBe('agent_working')
    expect(result.session_status).toBe('waiting_approval')
    expect(result.waiting_for_you).toBe(true)
  })

  it('reports no session for a task nothing is running', async () => {
    const result = (await handleTaskApiRoute('/get_session_status', { task_id: 't2' }, makeDb())) as {
      session_status: string
      waiting_for_you: boolean
    }
    expect(result.session_status).toBe('none')
    expect(result.waiting_for_you).toBe(false)
  })
})

describe('list_pending_approvals', () => {
  it('names every task that is blocked on the user', async () => {
    const result = (await handleTaskApiRoute('/list_pending_approvals', {}, makeDb())) as {
      pending: Array<{ task_id: string }>
      count: number
    }
    expect(result.count).toBe(1)
    expect(result.pending[0].task_id).toBe('t1')
  })

  it('reports none when nothing waits', async () => {
    agents.getSessionStatus.mockReturnValue({ status: 'working', agentId: 'a1', taskId: 't1' })
    const result = (await handleTaskApiRoute('/list_pending_approvals', {}, makeDb())) as {
      count: number
    }
    expect(result.count).toBe(0)
  })
})

describe('respond_to_checkpoint', () => {
  it('answers a checkpoint that is really waiting', async () => {
    const result = (await handleTaskApiRoute(
      '/respond_to_checkpoint',
      { task_id: 't1', approved: true },
      makeDb()
    )) as { success: boolean }
    expect(result.success).toBe(true)
    expect(agents.respondToPermission).toHaveBeenCalledWith('s1', true, undefined)
  })

  it('rejects with false, never with true', async () => {
    await handleTaskApiRoute('/respond_to_checkpoint', { task_id: 't1', approved: false }, makeDb())
    expect(agents.respondToPermission).toHaveBeenCalledWith('s1', false, undefined)
  })

  it('refuses when that task is not waiting', async () => {
    agents.getSessionStatus.mockReturnValue({ status: 'working', agentId: 'a1', taskId: 't1' })
    const result = (await handleTaskApiRoute(
      '/respond_to_checkpoint',
      { task_id: 't1', approved: true },
      makeDb()
    )) as { error?: string }
    expect(result.error).toMatch(/not waiting/i)
    expect(agents.respondToPermission).not.toHaveBeenCalled()
  })

  it('refuses when the task has no session at all', async () => {
    const result = (await handleTaskApiRoute(
      '/respond_to_checkpoint',
      { task_id: 't2', approved: true },
      makeDb()
    )) as { error?: string }
    expect(result.error).toMatch(/no agent session/i)
    expect(agents.respondToPermission).not.toHaveBeenCalled()
  })
})

describe('send_message', () => {
  it('sends to the agent of the task', async () => {
    const result = (await handleTaskApiRoute(
      '/send_message',
      { task_id: 't1', text: 'why did the test fail' },
      makeDb()
    )) as { success: boolean }
    expect(result.success).toBe(true)
    expect(agents.sendByTaskId).toHaveBeenCalledWith('t1', 'why did the test fail')
  })

  /**
   * Waking a stopped agent needs an agent to wake. Without one the send used
   * to fail deep inside with "Session not found:", naming neither the cause
   * nor the cure.
   */
  it('names the cause when the task has no agent', async () => {
    const db = makeDb()
    ;(db as unknown as { getTask: ReturnType<typeof vi.fn> }).getTask = vi.fn(() =>
      task('t3', 'Unassigned', { agent_id: null as never })
    )
    agents.findSessionByTaskId.mockReturnValue(undefined)

    const result = (await handleTaskApiRoute('/send_message', { task_id: 't3', text: 'hello' }, db)) as {
      error?: string
      reason?: string
    }
    expect(result.reason).toBe('no_agent')
    expect(result.error).toMatch(/no agent assigned/i)
    expect(result.error).toMatch(/update_task|start_task/)
    expect(agents.sendByTaskId).not.toHaveBeenCalled()
  })

  it('still sends when a session is running without an assignee on the record', async () => {
    const db = makeDb()
    ;(db as unknown as { getTask: ReturnType<typeof vi.fn> }).getTask = vi.fn(() =>
      task('t1', 'Fix login', { agent_id: null as never })
    )
    const result = (await handleTaskApiRoute('/send_message', { task_id: 't1', text: 'hello' }, db)) as {
      success?: boolean
    }
    expect(result.success).toBe(true)
  })

  it('refuses an empty message and an unknown task', async () => {
    const empty = (await handleTaskApiRoute('/send_message', { task_id: 't1', text: '  ' }, makeDb())) as {
      error?: string
    }
    expect(empty.error).toMatch(/text is required/i)

    const unknown = (await handleTaskApiRoute(
      '/send_message',
      { task_id: 'nope', text: 'hello' },
      makeDb()
    )) as { error?: string }
    expect(unknown.error).toMatch(/not found/i)
    expect(agents.sendByTaskId).not.toHaveBeenCalled()
  })
})

describe('stop_task', () => {
  it('stops a running agent', async () => {
    const result = (await handleTaskApiRoute('/stop_task', { task_id: 't1' }, makeDb())) as {
      success: boolean
    }
    expect(result.success).toBe(true)
    expect(agents.stopByTaskId).toHaveBeenCalledWith('t1')
  })

  it('says so when nothing is running, instead of pretending', async () => {
    agents.getActiveSessionsForTask.mockReturnValue([])
    const result = (await handleTaskApiRoute('/stop_task', { task_id: 't1' }, makeDb())) as {
      success: boolean
      reason?: string
    }
    expect(result.success).toBe(false)
    expect(result.reason).toBe('nothing_running')
    expect(agents.stopByTaskId).not.toHaveBeenCalled()
  })
})

describe('get_ui_state', () => {
  it('reports nothing while no window has published, and after one closes', async () => {
    const result = (await handleTaskApiRoute('/get_ui_state', {}, makeDb())) as { available: boolean }
    expect(result.available).toBe(false)
  })

  it('reports what the renderer last published', async () => {
    setTaskApiUiState({ view: 'canvas', selectedTaskId: 't1', selectedTaskTitle: 'Fix login' })
    const result = (await handleTaskApiRoute('/get_ui_state', {}, makeDb())) as {
      available: boolean
      view: string
      selectedTaskId: string
    }
    expect(result).toMatchObject({ available: true, view: 'canvas', selectedTaskId: 't1' })
  })
})
