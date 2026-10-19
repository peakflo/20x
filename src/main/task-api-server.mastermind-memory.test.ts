import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager } from './database'
import { handleRoute, setTaskApiNotifier } from './task-api-server'
import type { MastermindMemoryRecord } from '../shared/mastermind-memory'

let db: DatabaseManager

beforeEach(() => {
  ;({ db } = createTestDb())
})

afterEach(() => {
  setTaskApiNotifier(() => undefined)
})

describe('/remember', () => {
  it('creates a memory and notifies the renderer', async () => {
    const notify = vi.fn()
    setTaskApiNotifier(notify)

    const result = await handleRoute(db, '/remember', { content: 'Always use pnpm.', kind: 'preference' }) as { memory: MastermindMemoryRecord; deduped: boolean }
    expect(result.memory.content).toBe('Always use pnpm.')
    expect(result.deduped).toBe(false)
    expect(notify).toHaveBeenCalledWith('mastermind:memory-saved', expect.objectContaining({ deduped: false, updated: false }))
  })

  it('requires content and a valid kind', async () => {
    expect(await handleRoute(db, '/remember', { content: '', kind: 'fact' })).toEqual({ error: 'content is required' })
    expect(await handleRoute(db, '/remember', { content: 'x', kind: 'nonsense' })).toMatchObject({ error: expect.stringContaining('kind must be one of') })
  })

  it('refuses to store something that looks like a credential', async () => {
    const result = await handleRoute(db, '/remember', { content: 'the api key is sk-ant-abcdefghijklmnopqrstuvwxyz0123456789', kind: 'fact' }) as { error?: string }
    expect(result.error).toMatch(/Refused/)
    expect(db.listMemories({})).toHaveLength(0)
  })

  it('updates instead of duplicating a near-identical memory in the same scope', async () => {
    await handleRoute(db, '/remember', { content: 'Always use pnpm, never npm or yarn.', kind: 'preference' })
    const result = await handleRoute(db, '/remember', { content: 'Use pnpm always, never npm/yarn please.', kind: 'preference' }) as { memory: MastermindMemoryRecord; deduped: boolean }

    expect(result.deduped).toBe(true)
    expect(db.listMemories({})).toHaveLength(1)
    expect(db.listMemories({})[0].content).toBe('Use pnpm always, never npm/yarn please.')
  })

  it('does not dedupe across different scopes', async () => {
    await handleRoute(db, '/remember', { content: 'Always use pnpm, never npm or yarn.', kind: 'preference', scope: 'global' })
    const result = await handleRoute(db, '/remember', { content: 'Always use pnpm, never npm or yarn.', kind: 'preference', scope: 'project:abc' }) as { deduped: boolean }

    expect(result.deduped).toBe(false)
    expect(db.listMemories({})).toHaveLength(2)
  })

  it('updates an exact memory by id, and reports the previous value for Undo', async () => {
    const created = await handleRoute(db, '/remember', { content: 'Original', kind: 'fact' }) as { memory: MastermindMemoryRecord }
    const notify = vi.fn()
    setTaskApiNotifier(notify)

    const result = await handleRoute(db, '/remember', { id: created.memory.id, content: 'Corrected', kind: 'fact' }) as { memory: MastermindMemoryRecord; deduped: boolean }
    expect(result.memory.content).toBe('Corrected')
    expect(result.deduped).toBe(false)
    expect(notify).toHaveBeenCalledWith('mastermind:memory-saved', expect.objectContaining({
      updated: true,
      previous: expect.objectContaining({ content: 'Original' })
    }))
  })

  it('attributes a trusted agent\'s remember call to its own task when no source is given', async () => {
    // Routes don't see MCP scope directly — task-management-core.ts injects
    // `source: task:<id>` into the args before calling this route. Simulate that here.
    const result = await handleRoute(db, '/remember', { content: 'Use the staging DB for this project', kind: 'fact', source: 'task:task-42' }) as { memory: MastermindMemoryRecord }
    expect(result.memory.source).toBe('task:task-42')
  })
})

describe('/recall', () => {
  it('finds relevant memories and marks them used', async () => {
    await handleRoute(db, '/remember', { content: 'Always use pnpm, never npm or yarn.', kind: 'preference' })
    await handleRoute(db, '/remember', { content: 'Deploys happen on Fridays.', kind: 'procedure' })

    const result = await handleRoute(db, '/recall', { query: 'pnpm' }) as { memories: MastermindMemoryRecord[] }
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0].content).toContain('pnpm')
    expect(result.memories[0].last_used_at).not.toBeNull()
  })

  it('requires a query', async () => {
    expect(await handleRoute(db, '/recall', {})).toEqual({ error: 'query is required' })
  })
})

describe('/list_memories', () => {
  it('lists everything with no filters', async () => {
    await handleRoute(db, '/remember', { content: 'A', kind: 'fact' })
    await handleRoute(db, '/remember', { content: 'B', kind: 'preference' })

    const result = await handleRoute(db, '/list_memories', {}) as { memories: MastermindMemoryRecord[] }
    expect(result.memories).toHaveLength(2)
  })

  it('filters by scope and kind', async () => {
    await handleRoute(db, '/remember', { content: 'A global fact', kind: 'fact', scope: 'global' })
    await handleRoute(db, '/remember', { content: 'A project preference', kind: 'preference', scope: 'project:abc' })

    const result = await handleRoute(db, '/list_memories', { scope: 'project:abc' }) as { memories: MastermindMemoryRecord[] }
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0].content).toBe('A project preference')

    const byKind = await handleRoute(db, '/list_memories', { kind: 'fact' }) as { memories: MastermindMemoryRecord[] }
    expect(byKind.memories.map((m) => m.content)).toEqual(['A global fact'])
  })
})

describe('/forget', () => {
  it('deletes by exact id', async () => {
    const created = await handleRoute(db, '/remember', { content: 'Temporary', kind: 'fact' }) as { memory: MastermindMemoryRecord }
    const notify = vi.fn()
    setTaskApiNotifier(notify)

    const result = await handleRoute(db, '/forget', { id: created.memory.id }) as { success: boolean }
    expect(result.success).toBe(true)
    expect(db.getMemory(created.memory.id)).toBeUndefined()
    expect(notify).toHaveBeenCalledWith('mastermind:memory-deleted', { id: created.memory.id })
  })

  it('errors on an id that does not exist', async () => {
    expect(await handleRoute(db, '/forget', { id: 'nope' })).toEqual({ error: 'Memory not found' })
  })

  it('deletes the single match for an unambiguous query', async () => {
    await handleRoute(db, '/remember', { content: 'Always use pnpm for this repo', kind: 'preference' })
    await handleRoute(db, '/remember', { content: 'Deploys happen on Fridays', kind: 'procedure' })

    const result = await handleRoute(db, '/forget', { query: 'pnpm' }) as { success: boolean }
    expect(result.success).toBe(true)
    expect(db.listMemories({})).toHaveLength(1)
    expect(db.listMemories({})[0].content).toContain('Fridays')
  })

  it('returns candidates instead of deleting anything for an ambiguous query', async () => {
    // Deliberately low word-overlap with each other (unlike the dedupe test
    // above) so this exercises ambiguous-match handling, not dedupe-merge.
    await handleRoute(db, '/remember', { content: 'pnpm handles the frontend repo dependencies', kind: 'preference' })
    await handleRoute(db, '/remember', { content: 'The backend repo CI pipeline also runs pnpm but only on release tags', kind: 'procedure' })

    const result = await handleRoute(db, '/forget', { query: 'pnpm repo' }) as { ambiguous: boolean; candidates: unknown[] }
    expect(result.ambiguous).toBe(true)
    expect(result.candidates).toHaveLength(2)
    expect(db.listMemories({})).toHaveLength(2)
  })

  it('errors when neither id nor query is given', async () => {
    expect(await handleRoute(db, '/forget', {})).toEqual({ error: 'id or query is required' })
  })

  it('errors when a query matches nothing', async () => {
    expect(await handleRoute(db, '/forget', { query: 'nothing matches this' })).toEqual({ error: 'No memory matches that query.' })
  })
})
