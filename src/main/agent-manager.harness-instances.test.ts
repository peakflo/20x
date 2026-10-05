/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AgentManager } from './agent-manager'
import { MessagePartType, MessageRole } from './adapters/coding-agent-adapter'

// Adapters are recorded instead of spawning processes. Each records the home it was built for.
const built = vi.hoisted(() => [] as Array<{ kind: string; harnessHome?: string; self: any }>)
vi.mock('./adapters/claude-code-adapter', () => ({
  ClaudeCodeAdapter: vi.fn(function (this: any, options?: { harnessHome?: string }) {
    built.push({ kind: 'claude-code', harnessHome: options?.harnessHome, self: this })
  })
}))
vi.mock('./adapters/codex-app-server-adapter', () => ({
  CodexAppServerAdapter: vi.fn(function (this: any, options?: { harnessHome?: string }) {
    built.push({ kind: 'codex', harnessHome: options?.harnessHome, self: this })
  })
}))
vi.mock('./adapters/opencode-adapter', () => ({ OpencodeAdapter: vi.fn() }))
vi.mock('./adapters/acp-adapter', () => ({ AcpAdapter: vi.fn() }))
vi.mock('./adapters/pi-adapter', () => ({ PiAdapter: vi.fn() }))
vi.mock('./task-api-server', () => ({ getTaskApiPort: vi.fn(), waitForTaskApiServer: vi.fn() }))
vi.mock('./secret-broker', () => ({
  registerSecretSession: vi.fn(),
  unregisterSecretSession: vi.fn(),
  getSecretBrokerPort: vi.fn(),
  writeSecretShellWrapper: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  Notification: class { show = vi.fn(); on = vi.fn(); static isSupported = vi.fn(() => false) },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn(), isStarted: vi.fn(() => false) },
}))
// Filesystem layout is covered by harness-instances.test.ts. Here an instance is
// shareable unless its home path says otherwise.
vi.mock('./harness-instances', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./harness-instances')>()
  return {
    ...actual,
    linkSharedHistory: vi.fn(({ instanceHome }: { instanceHome: string }) => ({
      shareable: !instanceHome.includes('not-shareable'),
      links: []
    }))
  }
})

const KEY = 'context-handoff:task-1'
const TRANSCRIPT = [
  { taskId: 'task-1', partId: 'p1', seq: 1, role: 'user', content: 'Fix the login bug', partType: 'text', createdAt: 1, updatedAt: 1, rev: 1 },
  { taskId: 'task-1', partId: 'p2', seq: 2, role: 'assistant', content: 'Checking auth.ts', partType: 'text', createdAt: 2, updatedAt: 2, rev: 2 },
]

const INSTANCES: Record<string, { id: string; harness_type: string; label: string; home_path: string }> = {
  hi_work: { id: 'hi_work', harness_type: 'codex', label: 'Work', home_path: '/accounts/codex-work' },
  hi_personal: { id: 'hi_personal', harness_type: 'codex', label: 'Personal', home_path: '/accounts/codex-personal' },
  hi_claude_b: { id: 'hi_claude_b', harness_type: 'claude-code', label: 'Second', home_path: '/accounts/claude-second' },
  hi_blocked: { id: 'hi_blocked', harness_type: 'claude-code', label: 'Blocked', home_path: '/accounts/not-shareable-claude' },
}

/** Builds a manager over an in-memory task, agents and settings, with the adapter mocked out. */
function setup(opts: {
  agents: Record<string, { coding_agent: string; harness_instance_id?: string; auth_method?: string }>
  taskAgent: string
  sessionId?: string | null
}) {
  const settings = new Map<string, string>()
  settings.set(KEY, JSON.stringify({ fromAgentId: 'agent-old', recordedAt: 1, announced: false }))
  const task: Record<string, unknown> = {
    id: 'task-1', title: 'Ship the feature', description: '', repos: [], skill_ids: [], status: 'agent_working',
    agent_id: opts.taskAgent, session_id: opts.sessionId === undefined ? 'backend-session-1' : opts.sessionId
  }
  const agentRecords: Record<string, any> = {
    'agent-old': { id: 'agent-old', name: 'Claude Lead', config: { coding_agent: 'claude-code' } },
  }
  for (const [id, config] of Object.entries(opts.agents)) {
    agentRecords[id] = { id, name: `Agent ${id}`, config }
  }
  const db = {
    getTask: vi.fn(() => ({ ...task })),
    updateTask: vi.fn((_id: string, data: Record<string, unknown>) => { Object.assign(task, data) }),
    getAgent: vi.fn((id: string) => agentRecords[id]),
    getAgents: vi.fn(() => Object.values(agentRecords)),
    getHarnessInstance: vi.fn((id: string) => INSTANCES[id]),
    listHarnessInstances: vi.fn(() => Object.values(INSTANCES)),
    getSetting: vi.fn((key: string) => settings.get(key) ?? null),
    setSetting: vi.fn((key: string, value: string) => { settings.set(key, value) }),
    deleteSetting: vi.fn((key: string) => { settings.delete(key) }),
    getTranscriptParts: vi.fn(() => TRANSCRIPT),
    getWorkspaceDir: vi.fn(() => '/tmp/test-workspace'),
    getMcpServer: vi.fn(() => null),
    getSecretsByIds: vi.fn(() => []),
    getSecretsWithValues: vi.fn(() => []),
    getSkillsByIds: vi.fn(() => []),
    getTasks: vi.fn(() => []),
    usage: { getProviderUsageLimits: vi.fn(() => []) },
  } as unknown as ConstructorParameters<typeof AgentManager>[0]
  const manager = new AgentManager(db)
  // As at startup: every stored account is checked once, before any resume.
  manager.checkHarnessInstances()
  const emitted: Array<[string, any]> = []
  vi.spyOn(manager as any, 'sendToRenderer').mockImplementation((channel: unknown, data: unknown) => { emitted.push([channel as string, data]) })
  vi.spyOn(manager as any, 'buildMcpServersForAdapter').mockResolvedValue({})
  vi.spyOn(manager as any, 'writeSkillFiles').mockResolvedValue(undefined)
  vi.spyOn(manager as any, 'setupSecretSession').mockReturnValue(null)
  vi.spyOn(manager as any, 'buildSecretsSystemPrompt').mockReturnValue('')
  return { manager, db, task, settings, emitted }
}

/** A fake adapter whose first prompt can be made to fail. */
function fakeAdapter(overrides: Partial<Record<string, any>> = {}) {
  return {
    initialize: vi.fn(async () => undefined),
    createSession: vi.fn(async () => 'new-session-1'),
    resumeSession: vi.fn(async () => [{ id: 'msg-1', role: MessageRole.ASSISTANT, parts: [{ id: 'part-1', type: MessagePartType.TEXT, text: 'Earlier reply' }] }]),
    sendPrompt: vi.fn(async (_id: string, _parts: unknown, _config: unknown) => undefined),
    getStatus: vi.fn(async () => ({ type: 'working' })),
    destroySession: vi.fn(async () => undefined),
    ...overrides,
  }
}

function promptText(adapter: { sendPrompt: any }, call: number): string {
  return (adapter.sendPrompt.mock.calls[call] as unknown as [string, Array<{ text: string }>])[1][0].text
}

beforeEach(() => {
  built.length = 0
})

describe('one adapter per harness instance', () => {
  it('builds a separate adapter for each instance of one harness, each with its own home', () => {
    const { manager } = setup({
      agents: {
        'agent-work': { coding_agent: 'codex', harness_instance_id: 'hi_work' },
        'agent-personal': { coding_agent: 'codex', harness_instance_id: 'hi_personal' },
        'agent-default': { coding_agent: 'codex' },
      },
      taskAgent: 'agent-work',
    })

    const work = (manager as any).getAdapter('agent-work')
    const personal = (manager as any).getAdapter('agent-personal')
    const defaultOne = (manager as any).getAdapter('agent-default')

    // Two instances of one harness are two adapters, so they run in parallel with distinct environments.
    expect(work).not.toBe(personal)
    expect(work).not.toBe(defaultOne)
    // Stored accounts set their home. The default sets none, so its environment is the app's own.
    expect(built.map((b) => b.harnessHome)).toEqual(['/accounts/codex-work', '/accounts/codex-personal', undefined])
    // Agents of the same instance share one adapter.
    expect((manager as any).getAdapter('agent-work')).toBe(work)
  })

  it('keeps the instance home when a Claude instance is resumed under a second agent', () => {
    const { manager } = setup({
      agents: {
        'agent-a': { coding_agent: 'claude-code', harness_instance_id: 'hi_claude_b' },
        'agent-b': { coding_agent: 'claude-code', harness_instance_id: 'hi_claude_b' },
      },
      taskAgent: 'agent-a',
    })
    const a = (manager as any).getAdapter('agent-a')
    expect((manager as any).getAdapter('agent-b')).toBe(a)
    expect(built).toHaveLength(1)
    expect(built[0]).toMatchObject({ kind: 'claude-code', harnessHome: '/accounts/claude-second' })
  })

  it('labels an instance by its harness and name, and falls back to the harness for the default', () => {
    const { manager } = setup({ agents: {}, taskAgent: 'agent-old' })
    expect((manager as any).harnessInstanceLabel('hi_work', 'codex')).toBe('Codex · Work')
    expect((manager as any).harnessInstanceLabel('default:codex', 'codex')).toBe('Codex')
  })
})

describe('resuming on another harness instance', () => {
  it('keeps the session and holds the handoff marker until the first prompt is accepted (same harness, shareable)', async () => {
    const { manager, task, settings } = setup({
      agents: { 'agent-1': { coding_agent: 'claude-code', harness_instance_id: 'hi_claude_b' } },
      taskAgent: 'agent-1',
    })
    const adapter = fakeAdapter()
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)

    const resumed = await (manager as any).resumeAdapterSession(adapter, 'agent-1', 'task-1', 'backend-session-1')

    expect(resumed).toBe('backend-session-1')
    expect(adapter.resumeSession).toHaveBeenCalledWith('backend-session-1', expect.objectContaining({ harnessHome: '/accounts/claude-second' }))
    expect(task.session_id).toBe('backend-session-1')
    expect(settings.has(KEY)).toBe(true)
    const session = (manager as any).sessions.get(resumed)
    expect(session.nativeResumeAwaitingAck).toBe(true)

    // The backend accepted the prompt: the marker is removed, and no handoff block was sent.
    await (manager as any).sendMessage(resumed, 'continue please', 'task-1', 'agent-1')
    await vi.waitFor(() => expect(adapter.sendPrompt).toHaveBeenCalled())
    expect(promptText(adapter, 0)).not.toContain('## Conversation so far')
    ;(manager as any).completeNativeResume(session)
    expect(settings.has(KEY)).toBe(false)
  })

  it('shows the Continued on note with the new instance label', async () => {
    const { manager, emitted } = setup({
      agents: { 'agent-1': { coding_agent: 'claude-code', harness_instance_id: 'hi_claude_b' } },
      taskAgent: 'agent-1',
    })
    const adapter = fakeAdapter()
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)
    await (manager as any).resumeAdapterSession(adapter, 'agent-1', 'task-1', 'backend-session-1')
    const notes = emitted.filter(([, data]) => data?.data?.partType === 'harness-instance-continued')
    expect(notes).toHaveLength(1)
    expect(notes[0][1].data.content).toBe('Continued on Claude Code · Second')
  })

  it('a failed first prompt with a missing session delivers the handoff in the same message, on a new session', async () => {
    const { manager, task, settings, emitted } = setup({
      agents: { 'agent-1': { coding_agent: 'claude-code', harness_instance_id: 'hi_claude_b' } },
      taskAgent: 'agent-1',
    })
    const adapter = fakeAdapter({
      sendPrompt: vi.fn()
        .mockRejectedValueOnce(new Error('INCOMPATIBLE_SESSION_ID: This session does not exist on Claude Code servers.'))
        .mockResolvedValue(undefined),
    })
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)

    const resumed = await (manager as any).resumeAdapterSession(adapter, 'agent-1', 'task-1', 'backend-session-1')
    await (manager as any).sendMessage(resumed, 'continue please', 'task-1', 'agent-1')
    await vi.waitFor(() => expect(adapter.sendPrompt).toHaveBeenCalledTimes(2))

    // The retry carries the earlier conversation and the new request, in one message.
    const retry = promptText(adapter, 1)
    expect(retry).toContain('## Conversation so far with Claude Lead (Claude Code)')
    expect(retry).toContain('[#1 request] Ship the feature')
    expect(retry).toContain('[#2 assistant] Checking auth.ts')
    expect(retry).toContain('continue please')
    // The user's message is shown once, and no "start a new session?" dialog appears.
    expect(emitted.filter(([channel, data]) => channel === 'agent:output' && data?.data?.role === 'user' && data?.data?.content === 'continue please')).toHaveLength(1)
    expect(emitted.some(([channel]) => channel === 'agent:incompatible-session')).toBe(false)
    // The session id is replaced by the new session, and the marker is consumed.
    expect(task.session_id).toBe('new-session-1')
    expect(settings.has(KEY)).toBe(false)
  })

  it('does not resume a session on a non-shareable instance; the next session gets the handoff', async () => {
    const { manager, task, settings } = setup({
      agents: { 'agent-1': { coding_agent: 'claude-code', harness_instance_id: 'hi_blocked' } },
      taskAgent: 'agent-1',
    })
    const adapter = fakeAdapter()
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)

    const resumed = await (manager as any).resumeAdapterSession(adapter, 'agent-1', 'task-1', 'backend-session-1')

    expect(resumed).toBe('')
    expect(adapter.resumeSession).not.toHaveBeenCalled()
    // The session id is kept until a new session replaces it, and the marker is kept for the handoff.
    expect(task.session_id).toBe('backend-session-1')
    expect(settings.has(KEY)).toBe(true)

    const newId = await (manager as any).startSession('agent-1', 'task-1', undefined, true)
    await (manager as any).doSendAdapterMessage((manager as any).sessions.get(newId), newId, 'continue please')
    expect(promptText(adapter, 0)).toContain('## Conversation so far with Claude Lead (Claude Code)')
    expect(settings.has(KEY)).toBe(false)
  })

  it('a session-not-found error reported after the turn started still hands the task over, with the same message', async () => {
    const { manager, task, settings, emitted } = setup({
      agents: { 'agent-1': { coding_agent: 'claude-code', harness_instance_id: 'hi_claude_b' } },
      taskAgent: 'agent-1',
    })
    let pendingAtSend: unknown = 'not-sent'
    const adapter = fakeAdapter()
    // Captured while the first prompt is still in flight.
    adapter.sendPrompt.mockImplementationOnce(async (id: string) => {
      pendingAtSend = (manager as any).sessions.get(id)?.nativeResumeFirstPrompt
    })
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)

    const resumed = await (manager as any).resumeAdapterSession(adapter, 'agent-1', 'task-1', 'backend-session-1')
    await (manager as any).sendMessage(resumed, 'continue please', 'task-1', 'agent-1')
    await vi.waitFor(() => expect(adapter.sendPrompt).toHaveBeenCalledTimes(1))
    // The request to resend is recorded before the backend is asked, not after.
    expect(pendingAtSend).toEqual({ message: 'continue please', attachments: undefined })

    // The turn starts: BUSY is not an acknowledgement, so the handoff stays pending.
    const session = (manager as any).sessions.get(resumed)
    await (manager as any).settleNativeResume(resumed, session, { type: 'busy' }, [])
    expect(settings.has(KEY)).toBe(true)
    expect(session.nativeResumeAwaitingAck).toBe(true)

    // Claude Code then reports that the session is missing, on the stream.
    const outcome = await (manager as any).settleNativeResume(resumed, session, {
      type: 'error',
      message: 'INCOMPATIBLE_SESSION_ID: This session does not exist on Claude Code servers.'
    }, [])
    expect(outcome).toBe('fell-back')

    // A new session carries the conversation and the same message, in one prompt.
    await vi.waitFor(() => expect(adapter.sendPrompt).toHaveBeenCalledTimes(2))
    const retry = promptText(adapter, 1)
    expect(retry).toContain('## Conversation so far with Claude Lead (Claude Code)')
    expect(retry).toContain('continue please')
    expect(emitted.filter(([channel, data]) => channel === 'agent:output' && data?.data?.content === 'continue please')).toHaveLength(1)
    expect(emitted.some(([channel]) => channel === 'agent:incompatible-session')).toBe(false)
    expect(task.session_id).toBe('new-session-1')
    expect(settings.has(KEY)).toBe(false)
  })

  it('acknowledges the resume on assistant output, and then a later session error keeps the session', async () => {
    const { manager, task, settings } = setup({
      agents: { 'agent-1': { coding_agent: 'claude-code', harness_instance_id: 'hi_claude_b' } },
      taskAgent: 'agent-1',
    })
    const adapter = fakeAdapter()
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)
    const resumed = await (manager as any).resumeAdapterSession(adapter, 'agent-1', 'task-1', 'backend-session-1')
    await (manager as any).sendMessage(resumed, 'continue please', 'task-1', 'agent-1')
    await vi.waitFor(() => expect(adapter.sendPrompt).toHaveBeenCalledTimes(1))

    const session = (manager as any).sessions.get(resumed)
    await (manager as any).settleNativeResume(resumed, session, { type: 'busy' }, [{ role: 'assistant' }])
    expect(settings.has(KEY)).toBe(false)
    expect(session.nativeResumeAwaitingAck).toBe(false)
    expect(task.session_id).toBe('backend-session-1')
    expect(adapter.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('acknowledges on idle once the turn has started, and not before', async () => {
    const { manager, settings } = setup({
      agents: { 'agent-1': { coding_agent: 'claude-code', harness_instance_id: 'hi_claude_b' } },
      taskAgent: 'agent-1',
    })
    const adapter = fakeAdapter()
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)
    const resumed = await (manager as any).resumeAdapterSession(adapter, 'agent-1', 'task-1', 'backend-session-1')
    await (manager as any).sendMessage(resumed, 'continue please', 'task-1', 'agent-1')
    await vi.waitFor(() => expect(adapter.sendPrompt).toHaveBeenCalledTimes(1))

    const session = (manager as any).sessions.get(resumed)
    // Idle before the turn started is the state the resumed session already had: not an acknowledgement.
    await (manager as any).settleNativeResume(resumed, session, { type: 'idle' }, [])
    expect(settings.has(KEY)).toBe(true)
    // After the turn has run, idle is the successful result.
    ;(manager as any).pollingEntries.set(resumed, { hasSeenWork: true })
    await (manager as any).settleNativeResume(resumed, session, { type: 'idle' }, [])
    expect(settings.has(KEY)).toBe(false)
  })

  it('a different harness type is handed over, and the old session is not resumed', async () => {
    const { manager, task } = setup({
      agents: { 'agent-1': { coding_agent: 'codex' } },
      taskAgent: 'agent-1',
    })
    const adapter = fakeAdapter()
    vi.spyOn(manager as any, 'getAdapter').mockReturnValue(adapter)

    const resumed = await (manager as any).resumeAdapterSession(adapter, 'agent-1', 'task-1', 'backend-session-1')

    expect(resumed).toBe('')
    expect(adapter.resumeSession).not.toHaveBeenCalled()
    expect(task.session_id).toBe('backend-session-1')
  })

  it('a session that is not shareable never counts as native, even for the same harness', () => {
    const { manager } = setup({
      agents: { 'agent-1': { coding_agent: 'claude-code', harness_instance_id: 'hi_blocked' } },
      taskAgent: 'agent-1',
    })
    expect((manager as any).sharesSessionHistory((manager as any).db.getAgent('agent-1'))).toBe(false)
    expect((manager as any).sharesSessionHistory((manager as any).db.getAgent('agent-old'))).toBe(true)
  })

  it('an API-key agent never shares session history', () => {
    const { manager, db } = setup({
      agents: { 'agent-key': { coding_agent: 'codex', auth_method: 'api_key' } },
      taskAgent: 'agent-key',
    })
    expect((manager as any).sharesSessionHistory(db.getAgent('agent-key'))).toBe(false)
  })
})
