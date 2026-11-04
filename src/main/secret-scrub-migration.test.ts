import { describe, expect, it, vi } from 'vitest'
import { runSecretScrubMigration, runSecretScrubMigrationIfNeeded, SECRET_SCRUB_MIGRATION_SETTING } from './secret-scrub-migration'

interface FakeTask {
  id: string
  agent_id: string | null
  output_fields?: Array<{ id: string; name: string; type: string; value?: unknown }>
}

interface FakeSecret {
  id: string
  env_var_name: string
  value: string
}

function makeFakeDb(opts: {
  tasks: FakeTask[]
  transcriptParts: Record<string, Array<{ partId: string; content: string; tool?: unknown; payload?: unknown; createdAt: number }>>
  agents?: Record<string, { config?: { secret_ids?: string[]; api_keys?: { openai?: string; anthropic?: string; cursor?: string } } }>
  secrets?: FakeSecret[]
  settings?: Record<string, string>
}) {
  const settings = { ...(opts.settings ?? {}) }
  const agents = opts.agents ?? {}
  const secrets = opts.secrets ?? []
  const transcript = new Map(Object.entries(opts.transcriptParts).map(([k, v]) => [k, [...v]]))
  const updatedTasks: Array<{ id: string; data: unknown }> = []
  const upserts: Array<{ taskId: string; parts: unknown[] }> = []

  return {
    getTasks: vi.fn(() => opts.tasks),
    getTranscriptParts: vi.fn((taskId: string) => transcript.get(taskId) ?? []),
    upsertTranscriptParts: vi.fn((taskId: string, parts: Array<{ id: string; content?: string; tool?: unknown; payload?: unknown }>) => {
      upserts.push({ taskId, parts })
      const existing = transcript.get(taskId) ?? []
      for (const p of parts) {
        const row = existing.find((r) => r.partId === p.id)
        if (row) {
          if (p.content !== undefined) row.content = p.content
          if (p.tool !== undefined) row.tool = p.tool
          if (p.payload !== undefined) row.payload = p.payload
        }
      }
      transcript.set(taskId, existing)
      return { maxRev: 1, changedPartIds: parts.map((p) => p.id) }
    }),
    // Global aggregation: every agent, every secret — independent of any one
    // task's current agent_id. Mirrors buildAllKnownSecretEntries's shape.
    getAgents: vi.fn(() => Object.entries(agents).map(([id, a]) => ({ id, config: a.config }))),
    getAgent: vi.fn((id: string) => (agents[id] ? { id, config: agents[id].config } : undefined)),
    getSecrets: vi.fn(() => secrets.map((s) => ({ id: s.id, env_var_name: s.env_var_name }))),
    getSecretsWithValues: vi.fn((ids: string[]) => secrets.filter((s) => ids.includes(s.id))),
    updateTask: vi.fn((id: string, data: unknown) => {
      updatedTasks.push({ id, data })
      const task = opts.tasks.find((t) => t.id === id)
      if (task && (data as { output_fields?: FakeTask['output_fields'] }).output_fields) {
        task.output_fields = (data as { output_fields: FakeTask['output_fields'] }).output_fields
      }
    }),
    getSetting: vi.fn((key: string) => settings[key]),
    setSetting: vi.fn((key: string, value: string) => { settings[key] = value }),
    __inspect: { updatedTasks, upserts, transcript, settings }
  }
}

describe('runSecretScrubMigration', () => {
  it('scrubs transcript content, tool, and payload fields for a task whose agent has secrets', async () => {
    const db = makeFakeDb({
      tasks: [{ id: 'task-1', agent_id: 'agent-1' }],
      agents: { 'agent-1': { config: { secret_ids: ['s1'] } } },
      secrets: [{ id: 's1', env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }],
      transcriptParts: {
        'task-1': [
          { partId: 'p1', content: 'the key is leakedsecretvalue123 ok', createdAt: 1 },
          { partId: 'p2', content: 'nothing secret here', createdAt: 2 },
          { partId: 'p3', content: '', tool: { input: { command: 'echo leakedsecretvalue123' }, output: 'leakedsecretvalue123' }, createdAt: 3 },
          { partId: 'p4', content: '', payload: { raw: 'token=leakedsecretvalue123' }, createdAt: 4 }
        ]
      }
    })

    const result = await runSecretScrubMigration(db as never)

    expect(result.tasksScanned).toBe(1)
    expect(result.tasksWithSecrets).toBe(1)
    expect(result.partsScrubbed).toBe(3) // p1, p3, p4 changed, p2 untouched

    const parts = db.__inspect.transcript.get('task-1')!
    expect(parts.find((p) => p.partId === 'p1')!.content).toBe('the key is «$MY_SECRET» ok')
    expect(parts.find((p) => p.partId === 'p2')!.content).toBe('nothing secret here')
    const p3Tool = parts.find((p) => p.partId === 'p3')!.tool as { input: { command: string }; output: string }
    expect(p3Tool.input.command).toBe('echo «$MY_SECRET»')
    expect(p3Tool.output).toBe('«$MY_SECRET»')
    const p4Payload = parts.find((p) => p.partId === 'p4')!.payload as { raw: string }
    expect(p4Payload.raw).toBe('token=«$MY_SECRET»')
  })

  it('scrubs output_fields values', async () => {
    const db = makeFakeDb({
      tasks: [{
        id: 'task-1',
        agent_id: 'agent-1',
        output_fields: [{ id: 'f1', name: 'Summary', type: 'text', value: 'token=leakedsecretvalue123' }]
      }],
      agents: { 'agent-1': { config: { secret_ids: ['s1'] } } },
      secrets: [{ id: 's1', env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }],
      transcriptParts: {}
    })

    const result = await runSecretScrubMigration(db as never)
    expect(result.outputFieldsScrubbed).toBe(1)
    const task = db.getTasks()[0]
    expect(task.output_fields![0].value).toBe('token=«$MY_SECRET»')
  })

  it('still scrubs a task whose agent_id was reassigned to a DIFFERENT agent than the one that leaked the secret', async () => {
    // task-1 originally ran under agent-1 (which had MY_SECRET) and leaked
    // it into the transcript, but was later reassigned to agent-2 (which
    // has no secrets of its own). A per-agent-scoped scrubber built only
    // from task.agent_id ('agent-2') would see no secrets and skip this
    // task entirely, leaving the leak in place.
    const db = makeFakeDb({
      tasks: [{ id: 'task-1', agent_id: 'agent-2' }],
      agents: {
        'agent-1': { config: { secret_ids: ['s1'] } },
        'agent-2': { config: {} }
      },
      secrets: [{ id: 's1', env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }],
      transcriptParts: {
        'task-1': [{ partId: 'p1', content: 'the key is leakedsecretvalue123', createdAt: 1 }]
      }
    })

    const result = await runSecretScrubMigration(db as never)
    expect(result.partsScrubbed).toBe(1)
    expect(db.__inspect.transcript.get('task-1')![0].content).toBe('the key is «$MY_SECRET»')
  })

  it('still scrubs a task whose agent_id no longer resolves to any agent (deleted agent)', async () => {
    const db = makeFakeDb({
      tasks: [{ id: 'task-1', agent_id: 'deleted-agent' }],
      agents: {},
      secrets: [{ id: 's1', env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }],
      transcriptParts: {
        'task-1': [{ partId: 'p1', content: 'the key is leakedsecretvalue123', createdAt: 1 }]
      }
    })

    const result = await runSecretScrubMigration(db as never)
    expect(result.partsScrubbed).toBe(1)
  })

  it('scrubs a task with no agent_id at all when the leaked value still exists somewhere as a known secret', async () => {
    const db = makeFakeDb({
      tasks: [{ id: 'task-1', agent_id: null }],
      agents: {},
      secrets: [{ id: 's1', env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }],
      transcriptParts: {
        'task-1': [{ partId: 'p1', content: 'the key is leakedsecretvalue123', createdAt: 1 }]
      }
    })
    const result = await runSecretScrubMigration(db as never)
    expect(result.partsScrubbed).toBe(1)
  })

  it('skips everything (NOOP scrubber, no writes) when no secrets or api_keys exist anywhere', async () => {
    const db = makeFakeDb({
      tasks: [{ id: 'task-1', agent_id: 'agent-1' }],
      agents: { 'agent-1': { config: {} } },
      secrets: [],
      transcriptParts: { 'task-1': [{ partId: 'p1', content: 'ordinary text', createdAt: 1 }] }
    })

    const result = await runSecretScrubMigration(db as never)
    expect(result.tasksWithSecrets).toBe(0)
    expect(result.partsScrubbed).toBe(0)
    expect(db.upsertTranscriptParts).not.toHaveBeenCalled()
  })

  it('is idempotent — re-running finds nothing left to scrub', async () => {
    const db = makeFakeDb({
      tasks: [{ id: 'task-1', agent_id: 'agent-1' }],
      agents: { 'agent-1': { config: { secret_ids: ['s1'] } } },
      secrets: [{ id: 's1', env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }],
      transcriptParts: {
        'task-1': [{ partId: 'p1', content: 'the key is leakedsecretvalue123', createdAt: 1 }]
      }
    })

    const first = await runSecretScrubMigration(db as never)
    expect(first.partsScrubbed).toBe(1)

    const second = await runSecretScrubMigration(db as never)
    expect(second.partsScrubbed).toBe(0)
    expect(db.__inspect.transcript.get('task-1')![0].content).toBe('the key is «$MY_SECRET»')
  })
})

describe('runSecretScrubMigrationIfNeeded', () => {
  it('runs once and sets the completion setting', async () => {
    const db = makeFakeDb({
      tasks: [{ id: 'task-1', agent_id: 'agent-1' }],
      agents: { 'agent-1': { config: { secret_ids: ['s1'] } } },
      secrets: [{ id: 's1', env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }],
      transcriptParts: { 'task-1': [{ partId: 'p1', content: 'leakedsecretvalue123', createdAt: 1 }] }
    })

    const result = await runSecretScrubMigrationIfNeeded(db as never)
    expect(result).not.toBeNull()
    expect(db.__inspect.settings[SECRET_SCRUB_MIGRATION_SETTING]).toBeTruthy()
  })

  it('is a no-op (does not re-scan) once the completion setting is set', async () => {
    const db = makeFakeDb({
      tasks: [{ id: 'task-1', agent_id: 'agent-1' }],
      agents: { 'agent-1': { config: { secret_ids: ['s1'] } } },
      secrets: [{ id: 's1', env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }],
      transcriptParts: { 'task-1': [{ partId: 'p1', content: 'leakedsecretvalue123', createdAt: 1 }] },
      settings: { [SECRET_SCRUB_MIGRATION_SETTING]: '2026-01-01T00:00:00.000Z' }
    })

    const result = await runSecretScrubMigrationIfNeeded(db as never)
    expect(result).toBeNull()
    expect(db.getTasks).not.toHaveBeenCalled()
  })
})
