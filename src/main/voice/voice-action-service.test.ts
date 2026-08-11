import { describe, it, expect, beforeEach, vi } from 'vitest'
import { VoiceActionService, lastAssistantTextFromTranscript } from './voice-action-service'
import type { VoiceIntent, VoiceIntentProposal, VoiceUiContext } from '../../shared/voice'
import type { TaskRecord } from '../database'

function task(overrides: Partial<TaskRecord> & { id: string; title: string }): TaskRecord {
  return {
    description: '',
    type: 'general',
    priority: 'medium',
    status: 'not_started',
    assignee: '',
    due_date: null,
    labels: [],
    attachments: [],
    repos: [],
    output_fields: [],
    agent_id: null,
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
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as TaskRecord
}

function proposalFor(intent: VoiceIntent, confidence = 0.95): VoiceIntentProposal {
  return { intent, confidence, transcript: 'spoken words', source: 'deterministic', summary: 'summary' }
}

const TASKS = [
  task({ id: 't1', title: 'Fix login', status: 'agent_working', agent_id: 'a1' }),
  task({ id: 't2', title: 'Fix login on mobile', status: 'agent_working' }),
  task({ id: 't3', title: 'Write the release notes' }),
]

const AGENTS = [
  { id: 'a1', name: 'Codex' },
  { id: 'a2', name: 'Codex Reviewer' },
  { id: 'a3', name: 'Backend Agent' },
]

function makeService(settings: Record<string, string> = {}) {
  const notify = vi.fn()
  const db = {
    getTasks: vi.fn(() => TASKS),
    getTask: vi.fn((id: string) => TASKS.find((t) => t.id === id)),
    createTask: vi.fn((data: { title: string }) => task({ id: 'new', title: data.title })),
    updateTask: vi.fn((id: string) => TASKS.find((t) => t.id === id)),
    getAgents: vi.fn(() => AGENTS),
    getTranscriptParts: vi.fn(() => []),
    getSetting: vi.fn((key: string) => settings[key]),
  }
  const agents = {
    startTask: vi.fn(async () => ({ action: 'task_started' as const, sessionId: 's1' })),
    sendByTaskId: vi.fn(async () => ({ sessionId: 's1' })),
    respondToPermission: vi.fn(async () => undefined),
    findSessionByTaskId: vi.fn(() => ({ sessionId: 's1', session: {} })),
    getSessionStatus: vi.fn(() => ({ status: 'waiting_approval', agentId: 'a1', taskId: 't1' })),
    getLastAssistantMessage: vi.fn(() => 'The build is green.'),
  }
  const service = new VoiceActionService({
    db: db as never,
    agents: agents as never,
    notify,
  })
  return { service, db, agents, notify }
}

const ON_TASK: VoiceUiContext = { selectedTaskId: 't1', view: 'tasks' }

describe('VoiceActionService — confirmation policy', () => {
  let ctx: ReturnType<typeof makeService>
  beforeEach(() => {
    ctx = makeService()
  })

  it('asks before it creates a task', async () => {
    const outcome = await ctx.service.apply('turn1', proposalFor({ type: 'create_task', title: 'Fix login' }), {})
    expect(outcome.status).toBe('needs_confirmation')
    expect(ctx.db.createTask).not.toHaveBeenCalled()
  })

  it('creates the task without asking when quick create is on', async () => {
    const quick = makeService({ voice_quick_create: 'true' })
    const outcome = await quick.service.apply('turn1', proposalFor({ type: 'create_task', title: 'Fix login' }), {})
    expect(outcome.status).toBe('executed')
    expect(quick.db.createTask).toHaveBeenCalledTimes(1)
  })

  it('always asks before it answers a checkpoint', async () => {
    const approve = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'approve_checkpoint', taskRef: { kind: 'current' } }),
      { ...ON_TASK, pendingApproval: { taskId: 't1', sessionId: 's1' } }
    )
    expect(approve.status).toBe('needs_confirmation')
    expect(approve.status === 'needs_confirmation' && approve.reason).toBe('destructive')
    expect(ctx.agents.respondToPermission).not.toHaveBeenCalled()
  })

  it('asks before it starts a task that has no agent', async () => {
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'start_task', taskRef: { kind: 'id', id: 't2' } }),
      {}
    )
    expect(outcome.status).toBe('needs_confirmation')
    expect(ctx.agents.startTask).not.toHaveBeenCalled()
  })

  it('starts a task that already has an agent', async () => {
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'start_task', taskRef: { kind: 'id', id: 't1' } }),
      {}
    )
    expect(outcome.status).toBe('executed')
    expect(ctx.agents.startTask).toHaveBeenCalledWith('t1')
  })

  it('asks when the words were not clear', async () => {
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'reply_to_agent', taskRef: { kind: 'current' }, message: 'hello' }, 0.4),
      ON_TASK
    )
    expect(outcome.status).toBe('needs_confirmation')
    expect(outcome.status === 'needs_confirmation' && outcome.reason).toBe('low_confidence')
  })

  it('sends a clear message to the agent without a second step', async () => {
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'reply_to_agent', taskRef: { kind: 'current' }, message: 'why did the test fail' }),
      ON_TASK
    )
    expect(outcome.status).toBe('executed')
    expect(ctx.agents.sendByTaskId).toHaveBeenCalledWith('t1', 'why did the test fail')
  })
})

describe('VoiceActionService — checkpoint safety', () => {
  it('refuses an approval when no checkpoint is on screen', async () => {
    const ctx = makeService()
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'approve_checkpoint', taskRef: { kind: 'current' } }),
      ON_TASK,
      true
    )
    expect(outcome.status).toBe('rejected')
    expect(outcome.status === 'rejected' && outcome.reason).toBe('no_pending_approval')
    expect(ctx.agents.respondToPermission).not.toHaveBeenCalled()
  })

  it('refuses an approval when the session no longer waits', async () => {
    const ctx = makeService()
    ctx.agents.getSessionStatus.mockReturnValue({ status: 'working', agentId: 'a1', taskId: 't1' })
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'approve_checkpoint', taskRef: { kind: 'current' } }),
      { ...ON_TASK, pendingApproval: { taskId: 't1', sessionId: 's1' } },
      true
    )
    expect(outcome.status).toBe('rejected')
    expect(ctx.agents.respondToPermission).not.toHaveBeenCalled()
  })

  it('refuses an approval that belongs to another task', async () => {
    const ctx = makeService()
    ctx.agents.getSessionStatus.mockReturnValue({ status: 'waiting_approval', agentId: 'a1', taskId: 't3' })
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'approve_checkpoint', taskRef: { kind: 'current' } }),
      { ...ON_TASK, pendingApproval: { taskId: 't1', sessionId: 's1' } },
      true
    )
    expect(outcome.status).toBe('rejected')
    expect(ctx.agents.respondToPermission).not.toHaveBeenCalled()
  })

  it('answers the visible checkpoint after the confirmation', async () => {
    const ctx = makeService()
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'approve_checkpoint', taskRef: { kind: 'current' } }),
      { ...ON_TASK, pendingApproval: { taskId: 't1', sessionId: 's1' } },
      true
    )
    expect(outcome.status).toBe('executed')
    expect(ctx.agents.respondToPermission).toHaveBeenCalledWith('s1', true, undefined)
  })

  it('rejects with `false`, never with `true`', async () => {
    const ctx = makeService()
    await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'reject_checkpoint', taskRef: { kind: 'current' } }),
      { ...ON_TASK, pendingApproval: { taskId: 't1', sessionId: 's1' } },
      true
    )
    expect(ctx.agents.respondToPermission).toHaveBeenCalledWith('s1', false, undefined)
  })
})

describe('VoiceActionService — target resolution', () => {
  it('uses the task the user is looking at', async () => {
    const ctx = makeService()
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'reply_to_agent', taskRef: { kind: 'current' }, message: 'hi' }),
      ON_TASK
    )
    expect(outcome.status).toBe('executed')
  })

  it('refuses when no task is open and none was named', async () => {
    const ctx = makeService()
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'reply_to_agent', taskRef: { kind: 'current' }, message: 'hi' }),
      {}
    )
    expect(outcome.status).toBe('rejected')
    expect(outcome.status === 'rejected' && outcome.reason).toBe('no_target')
  })

  it('takes a unique exact title over a longer partial match', async () => {
    const ctx = makeService()
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'reply_to_agent', taskRef: { kind: 'title', text: 'fix login' }, message: 'hi' }),
      {}
    )
    expect(outcome.status).toBe('executed')
    expect(ctx.agents.sendByTaskId).toHaveBeenCalledWith('t1', 'hi')
  })

  it('never starts a task after a partial title match without asking', async () => {
    const ctx = makeService()
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'start_task', taskRef: { kind: 'title', text: 'release notes' } }),
      {}
    )
    expect(outcome.status).toBe('needs_confirmation')
    expect(outcome.status === 'needs_confirmation' && outcome.reason).toBe('ambiguous_task')
    expect(ctx.agents.startTask).not.toHaveBeenCalled()
  })

  it('offers a choice when more than one title matches', async () => {
    const ctx = makeService()
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'reply_to_agent', taskRef: { kind: 'title', text: 'login' }, message: 'hi' }),
      {}
    )
    expect(outcome.status).toBe('needs_confirmation')
    expect(outcome.status === 'needs_confirmation' && outcome.candidates?.length).toBe(2)
    expect(ctx.agents.sendByTaskId).not.toHaveBeenCalled()
  })

  it('reports a title it cannot find', async () => {
    const ctx = makeService()
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'start_task', taskRef: { kind: 'title', text: 'buy milk' } }),
      {}
    )
    expect(outcome.status).toBe('rejected')
    expect(outcome.status === 'rejected' && outcome.reason).toBe('not_found')
  })

  it('offers a choice when more than one agent name matches', async () => {
    const ctx = makeService()
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'assign_agent', taskRef: { kind: 'current' }, agentName: 'Codex' }),
      ON_TASK
    )
    // "Codex" is an exact match for one agent, so this one runs.
    expect(outcome.status).toBe('executed')

    const partial = await ctx.service.apply(
      'turn2',
      proposalFor({ type: 'assign_agent', taskRef: { kind: 'current' }, agentName: 'code' }),
      ON_TASK
    )
    expect(partial.status).toBe('needs_confirmation')
    expect(partial.status === 'needs_confirmation' && partial.reason).toBe('ambiguous_agent')
  })
})

describe('VoiceActionService — events', () => {
  it('emits exactly one canonical event for a created task', async () => {
    const ctx = makeService({ voice_quick_create: 'true' })
    await ctx.service.apply('turn1', proposalFor({ type: 'create_task', title: 'Fix login' }), {})
    const created = ctx.notify.mock.calls.filter(([channel]) => channel === 'task:created')
    expect(created).toHaveLength(1)
    expect(created[0][1]).toMatchObject({ task: { title: 'Fix login' } })
  })

  it('emits exactly one canonical event for an assignment', async () => {
    const ctx = makeService()
    await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'assign_agent', taskRef: { kind: 'current' }, agentName: 'Codex' }),
      ON_TASK
    )
    const updated = ctx.notify.mock.calls.filter(([channel]) => channel === 'task:updated')
    expect(updated).toHaveLength(1)
    expect(updated[0][1]).toEqual({ taskId: 't1', updates: { agent_id: 'a1' } })
  })

  it('asks the renderer to navigate without touching the database', async () => {
    const ctx = makeService()
    const outcome = await ctx.service.apply('turn1', proposalFor({ type: 'navigate', destination: 'canvas' }), ON_TASK)
    expect(outcome.status).toBe('executed')
    expect(ctx.notify).toHaveBeenCalledWith('voice:navigate', { destination: 'canvas', taskId: 't1' })
    expect(ctx.db.updateTask).not.toHaveBeenCalled()
  })

  it('reads back the last agent answer', async () => {
    const ctx = makeService()
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'read_last_answer', taskRef: { kind: 'current' } }),
      ON_TASK
    )
    expect(outcome.status).toBe('executed')
    expect(outcome.status === 'executed' && outcome.message).toBe('The build is green.')
  })
})

describe('VoiceActionService — schema guard', () => {
  it('runs nothing for an intent that is off-schema', async () => {
    const ctx = makeService()
    const outcome = await ctx.service.apply(
      'turn1',
      { intent: { type: 'run_shell', command: 'rm -rf /' } as unknown as VoiceIntent,
        confidence: 1,
        transcript: 'x',
        source: 'classifier',
        summary: 'x' },
      ON_TASK,
      true
    )
    expect(outcome.status).toBe('rejected')
    expect(ctx.db.createTask).not.toHaveBeenCalled()
    expect(ctx.agents.startTask).not.toHaveBeenCalled()
    expect(ctx.agents.respondToPermission).not.toHaveBeenCalled()
  })

  it('reports a failure instead of throwing', async () => {
    const ctx = makeService()
    ctx.agents.startTask.mockRejectedValue(new Error('the agent is offline'))
    const outcome = await ctx.service.apply(
      'turn1',
      proposalFor({ type: 'start_task', taskRef: { kind: 'id', id: 't1' } }),
      {}
    )
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'failed', message: 'the agent is offline' })
  })
})

describe('the last answer', () => {
  it('takes the newest plain assistant text', () => {
    expect(
      lastAssistantTextFromTranscript([
        { role: 'assistant', content: 'An older answer.', partType: 'text' },
        { role: 'user', content: 'And then?' },
        { role: 'assistant', content: 'The newest answer.', partType: 'text' },
      ])
    ).toBe('The newest answer.')
  })

  it('never reads tool output, a question, an error or hidden reasoning', () => {
    expect(
      lastAssistantTextFromTranscript([
        { role: 'assistant', content: 'The answer.', partType: 'text' },
        { role: 'assistant', content: 'ran ls -la', partType: 'tool' },
        { role: 'assistant', content: 'thinking about it', partType: 'reasoning' },
        { role: 'assistant', content: 'it broke', partType: 'error' },
      ])
    ).toBe('The answer.')
  })

  it('accepts a part with no type, which is plain text', () => {
    expect(lastAssistantTextFromTranscript([{ role: 'assistant', content: 'Plain.' }])).toBe('Plain.')
  })

  it('reports nothing when the agent has said nothing', () => {
    expect(lastAssistantTextFromTranscript([])).toBeNull()
    expect(lastAssistantTextFromTranscript([{ role: 'user', content: 'Hello?' }])).toBeNull()
    expect(
      lastAssistantTextFromTranscript([{ role: 'assistant', content: '   ', partType: 'text' }])
    ).toBeNull()
  })
})
