import { describe, expect, it, vi } from 'vitest'
import { runSecretScrubMigration, runSecretScrubMigrationIfNeeded, SECRET_SCRUB_MIGRATION_SETTING } from './secret-scrub-migration'

interface FakeTask {
  id: string
  agent_id: string | null
  output_fields?: Array<{ id: string; name: string; type: string; value?: unknown }>
}

function makeFakeDb(opts: {
  tasks: FakeTask[]
  transcriptParts: Record<string, Array<{ partId: string; content: string; tool?: unknown; createdAt: number }>>
  agents: Record<string, { config?: { secret_ids?: string[]; api_keys?: { openai?: string } } }>
  secretsByAgent: Record<string, Array<{ env_var_name: string; value: string }>>
  settings?: Record<string, string>
}) {
  const settings = { ...(opts.settings ?? {}) }
  const transcript = new Map(Object.entries(opts.transcriptParts).map(([k, v]) => [k, [...v]]))
  const updatedTasks: Array<{ id: string; data: unknown }> = []
  const upserts: Array<{ taskId: string; parts: unknown[] }> = []

  return {
    getTasks: vi.fn(() => opts.tasks),
    getTranscriptParts: vi.fn((taskId: string) => transcript.get(taskId) ?? []),
    upsertTranscriptParts: vi.fn((taskId: string, parts: Array<{ id: string; content?: string; tool?: unknown }>) => {
      upserts.push({ taskId, parts })
      const existing = transcript.get(taskId) ?? []
      for (const p of parts) {
        const row = existing.find((r) => r.partId === p.id)
        if (row) {
          if (p.content !== undefined) row.content = p.content
          if (p.tool !== undefined) row.tool = p.tool
        }
      }
      transcript.set(taskId, existing)
      return { maxRev: 1, changedPartIds: parts.map((p) => p.id) }
    }),
    getAgent: vi.fn((id: string) => (opts.agents[id] ? { id, config: opts.agents[id].config } : undefined)),
    getSecretsWithValues: vi.fn((ids: string[]) => {
      // Find which agent these ids belong to via agents map (simplified: just use the first agent with secret_ids overlapping)
      for (const [agentId, agent] of Object.entries(opts.agents)) {
        if (agent.config?.secret_ids && ids.every((i) => agent.config!.secret_ids!.includes(i))) {
          return opts.secretsByAgent[agentId] ?? []
        }
      }
      return []
    }),
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
  it('scrubs transcript content and tool fields for a task whose agent has secrets', async () => {
    const db = makeFakeDb({
      tasks: [{ id: 'task-1', agent_id: 'agent-1' }],
      agents: { 'agent-1': { config: { secret_ids: ['s1'] } } },
      secretsByAgent: { 'agent-1': [{ env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }] },
      transcriptParts: {
        'task-1': [
          { partId: 'p1', content: 'the key is leakedsecretvalue123 ok', createdAt: 1 },
          { partId: 'p2', content: 'nothing secret here', createdAt: 2 },
          { partId: 'p3', content: '', tool: { input: { command: 'echo leakedsecretvalue123' }, output: 'leakedsecretvalue123' }, createdAt: 3 }
        ]
      }
    })

    const result = await runSecretScrubMigration(db as never)

    expect(result.tasksScanned).toBe(1)
    expect(result.tasksWithSecrets).toBe(1)
    expect(result.partsScrubbed).toBe(2) // p1 and p3 changed, p2 untouched

    const parts = db.__inspect.transcript.get('task-1')!
    expect(parts.find((p) => p.partId === 'p1')!.content).toBe('the key is «$MY_SECRET» ok')
    expect(parts.find((p) => p.partId === 'p2')!.content).toBe('nothing secret here')
    const p3Tool = parts.find((p) => p.partId === 'p3')!.tool as { input: { command: string }; output: string }
    expect(p3Tool.input.command).toBe('echo «$MY_SECRET»')
    expect(p3Tool.output).toBe('«$MY_SECRET»')
  })

  it('scrubs output_fields values', async () => {
    const db = makeFakeDb({
      tasks: [{
        id: 'task-1',
        agent_id: 'agent-1',
        output_fields: [{ id: 'f1', name: 'Summary', type: 'text', value: 'token=leakedsecretvalue123' }]
      }],
      agents: { 'agent-1': { config: { secret_ids: ['s1'] } } },
      secretsByAgent: { 'agent-1': [{ env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }] },
      transcriptParts: {}
    })

    const result = await runSecretScrubMigration(db as never)
    expect(result.outputFieldsScrubbed).toBe(1)
    const task = db.getTasks()[0]
    expect(task.output_fields![0].value).toBe('token=«$MY_SECRET»')
  })

  it('skips tasks whose agent has no secrets (NOOP scrubber, no writes)', async () => {
    const db = makeFakeDb({
      tasks: [{ id: 'task-1', agent_id: 'agent-1' }],
      agents: { 'agent-1': { config: {} } },
      secretsByAgent: {},
      transcriptParts: { 'task-1': [{ partId: 'p1', content: 'ordinary text', createdAt: 1 }] }
    })

    const result = await runSecretScrubMigration(db as never)
    expect(result.tasksWithSecrets).toBe(0)
    expect(result.partsScrubbed).toBe(0)
    expect(db.upsertTranscriptParts).not.toHaveBeenCalled()
  })

  it('skips tasks with no agent_id', async () => {
    const db = makeFakeDb({
      tasks: [{ id: 'task-1', agent_id: null }],
      agents: {},
      secretsByAgent: {},
      transcriptParts: {}
    })
    const result = await runSecretScrubMigration(db as never)
    expect(result.tasksWithSecrets).toBe(0)
  })

  it('is idempotent — re-running finds nothing left to scrub', async () => {
    const db = makeFakeDb({
      tasks: [{ id: 'task-1', agent_id: 'agent-1' }],
      agents: { 'agent-1': { config: { secret_ids: ['s1'] } } },
      secretsByAgent: { 'agent-1': [{ env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }] },
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
      secretsByAgent: { 'agent-1': [{ env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }] },
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
      secretsByAgent: { 'agent-1': [{ env_var_name: 'MY_SECRET', value: 'leakedsecretvalue123' }] },
      transcriptParts: { 'task-1': [{ partId: 'p1', content: 'leakedsecretvalue123', createdAt: 1 }] },
      settings: { [SECRET_SCRUB_MIGRATION_SETTING]: '2026-01-01T00:00:00.000Z' }
    })

    const result = await runSecretScrubMigrationIfNeeded(db as never)
    expect(result).toBeNull()
    expect(db.getTasks).not.toHaveBeenCalled()
  })
})
