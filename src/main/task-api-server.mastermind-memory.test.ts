import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager } from './database'
import {
  clearMemorySessionsForTest,
  handleRoute,
  logSafeRouteBody,
  registerMemorySession,
  setTaskApiNotifier,
  unregisterMemorySession
} from './task-api-server'
import type { MastermindMemoryRecord } from '../shared/mastermind-memory'

let db: DatabaseManager

/** A valid token registered for every test, standing in for Mastermind's own session. */
const MASTERMIND_TOKEN = 'tok-mastermind'
/** A second valid token for a trusted task agent, standing in for a real subtask. */
const TRUSTED_AGENT_TOKEN = 'tok-trusted-agent'

/** Calls handleRoute with the Mastermind token already attached — the common case below. */
function call(route: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return handleRoute(db, route, { ...params, __memoryToken: MASTERMIND_TOKEN })
}

beforeEach(() => {
  ;({ db } = createTestDb())
  clearMemorySessionsForTest()
  registerMemorySession(MASTERMIND_TOKEN, 'mastermind-agent-1', 'mastermind-session')
  registerMemorySession(TRUSTED_AGENT_TOKEN, 'trusted-agent-1', 'task-42')
})

afterEach(() => {
  setTaskApiNotifier(() => undefined)
  clearMemorySessionsForTest()
})

describe('memory routes — token enforcement (requireMemoryToken)', () => {
  const ROUTES = ['/remember', '/recall', '/forget', '/list_memories']

  for (const route of ROUTES) {
    it(`${route} refuses a call with no token at all`, async () => {
      const result = await handleRoute(db, route, { content: 'x', kind: 'fact', query: 'x', id: 'x' }) as { error?: string }
      expect(result.error).toMatch(/Unauthorized/)
    })

    it(`${route} refuses a call with an unregistered/invalid token`, async () => {
      const result = await handleRoute(db, route, { content: 'x', kind: 'fact', query: 'x', id: 'x', __memoryToken: 'not-a-real-token' }) as { error?: string }
      expect(result.error).toMatch(/Unauthorized/)
    })
  }

  it('a plain HTTP call with no scope at all is refused exactly like an MCP one — the token is the real boundary on both paths', async () => {
    // handleRoute is reached identically whether the caller came through the
    // scoped /mcp JSON-RPC endpoint or a raw HTTP POST straight to /remember
    // — this route never sees which one it was. No token means no access either way.
    const result = await handleRoute(db, '/remember', { content: 'planted by an unrelated local process', kind: 'fact' }) as { error?: string }
    expect(result.error).toMatch(/Unauthorized/)
    expect(db.listMemories({})).toHaveLength(0)
  })

  it('a token works once registered and stops working once unregistered (session ended)', async () => {
    registerMemorySession('tok-temp', 'agent-temp', 'mastermind-session')
    expect(await handleRoute(db, '/list_memories', { __memoryToken: 'tok-temp' })).toEqual({ memories: [] })

    unregisterMemorySession('tok-temp')
    const result = await handleRoute(db, '/list_memories', { __memoryToken: 'tok-temp' }) as { error?: string }
    expect(result.error).toMatch(/Unauthorized/)
  })
})

describe('/remember', () => {
  it('creates a memory and notifies the renderer', async () => {
    const notify = vi.fn()
    setTaskApiNotifier(notify)

    const result = await call('/remember', { content: 'Always use pnpm.', kind: 'preference' }) as { memory: MastermindMemoryRecord; deduped: boolean }
    expect(result.memory.content).toBe('Always use pnpm.')
    expect(result.deduped).toBe(false)
    expect(notify).toHaveBeenCalledWith('mastermind:memory-saved', expect.objectContaining({ deduped: false, updated: false }))
  })

  it('requires content and a valid kind', async () => {
    expect(await call('/remember', { content: '', kind: 'fact' })).toEqual({ error: 'content is required' })
    expect(await call('/remember', { content: 'x', kind: 'nonsense' })).toMatchObject({ error: expect.stringContaining('kind must be one of') })
  })

  it('refuses to store something that looks like a credential', async () => {
    const result = await call('/remember', { content: 'the api key is sk-ant-abcdefghijklmnopqrstuvwxyz0123456789', kind: 'fact' }) as { error?: string }
    expect(result.error).toMatch(/Refused/)
    expect(db.listMemories({})).toHaveLength(0)
  })

  it('updates instead of duplicating a near-identical memory in the same scope', async () => {
    await call('/remember', { content: 'Always use pnpm, never npm or yarn.', kind: 'preference' })
    const result = await call('/remember', { content: 'Use pnpm always, never npm/yarn please.', kind: 'preference' }) as { memory: MastermindMemoryRecord; deduped: boolean }

    expect(result.deduped).toBe(true)
    expect(db.listMemories({})).toHaveLength(1)
    expect(db.listMemories({})[0].content).toBe('Use pnpm always, never npm/yarn please.')
  })

  it('does not dedupe across different scopes', async () => {
    await call('/remember', { content: 'Always use pnpm, never npm or yarn.', kind: 'preference', scope: 'global' })
    const result = await call('/remember', { content: 'Always use pnpm, never npm or yarn.', kind: 'preference', scope: 'project:abc' }) as { deduped: boolean }

    expect(result.deduped).toBe(false)
    expect(db.listMemories({})).toHaveLength(2)
  })

  it('updates an exact memory by id, and reports the previous value for Undo', async () => {
    const created = await call('/remember', { content: 'Original', kind: 'fact' }) as { memory: MastermindMemoryRecord }
    const notify = vi.fn()
    setTaskApiNotifier(notify)

    const result = await call('/remember', { id: created.memory.id, content: 'Corrected', kind: 'fact' }) as { memory: MastermindMemoryRecord; deduped: boolean }
    expect(result.memory.content).toBe('Corrected')
    expect(result.deduped).toBe(false)
    expect(notify).toHaveBeenCalledWith('mastermind:memory-saved', expect.objectContaining({
      updated: true,
      previous: expect.objectContaining({ content: 'Original' })
    }))
  })

  describe('server-side source (never trusts a caller-supplied value)', () => {
    it("derives source from the Mastermind session's own token as agent:<id>", async () => {
      const result = await call('/remember', { content: 'A fact Mastermind learned', kind: 'fact' }) as { memory: MastermindMemoryRecord }
      expect(result.memory.source).toBe('agent:mastermind-agent-1')
    })

    it("derives source from a trusted task agent's token as agent:<id>/task:<id>", async () => {
      const result = await handleRoute(db, '/remember', {
        content: 'The staging DB needs a manual migration step',
        kind: 'procedure',
        __memoryToken: TRUSTED_AGENT_TOKEN
      }) as { memory: MastermindMemoryRecord }
      expect(result.memory.source).toBe('agent:trusted-agent-1/task:task-42')
    })

    it('ignores a caller-supplied source="user-stated" — only the identity behind the token counts', async () => {
      const result = await call('/remember', { content: 'x', kind: 'fact', source: 'user-stated' }) as { memory: MastermindMemoryRecord }
      expect(result.memory.source).toBe('agent:mastermind-agent-1')
    })

    it('also overrides source on an id-based update, not just a create', async () => {
      const created = await call('/remember', { content: 'Original', kind: 'fact' }) as { memory: MastermindMemoryRecord }
      const result = await call('/remember', { id: created.memory.id, content: 'Edited', kind: 'fact', source: 'user-stated' }) as { memory: MastermindMemoryRecord }
      expect(result.memory.source).toBe('agent:mastermind-agent-1')
    })
  })
})

describe('/recall', () => {
  it('finds relevant memories and marks them used', async () => {
    await call('/remember', { content: 'Always use pnpm, never npm or yarn.', kind: 'preference' })
    await call('/remember', { content: 'Deploys happen on Fridays.', kind: 'procedure' })

    const result = await call('/recall', { query: 'pnpm' }) as { memories: MastermindMemoryRecord[] }
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0].content).toContain('pnpm')
    expect(result.memories[0].last_used_at).not.toBeNull()
  })

  it('requires a query', async () => {
    expect(await call('/recall', {})).toEqual({ error: 'query is required' })
  })

  it('finds a memory written in Cyrillic', async () => {
    await call('/remember', { content: 'Всегда используй pnpm, а не npm.', kind: 'preference' })
    const result = await call('/recall', { query: 'используй' }) as { memories: MastermindMemoryRecord[] }
    expect(result.memories).toHaveLength(1)
  })

  it('finds a memory written in CJK (Chinese) by its exact tokenised run', async () => {
    // FTS5's unicode61 tokenizer (no CJK word segmentation) treats a whole
    // contiguous run of CJK characters as one token, not characters or
    // words within it — so a query matching that run exactly always worked.
    // The partial-phrase case (a true substring of the run) is covered next
    // — it used to return nothing and now falls back to a LIKE scan.
    await call('/remember', { content: '发布分支总是 main，不是 master。', kind: 'fact' })
    const result = await call('/recall', { query: '发布分支总是' }) as { memories: MastermindMemoryRecord[] }
    expect(result.memories.length).toBeGreaterThan(0)
  })

  it('finds a memory by a genuine PARTIAL CJK phrase, through the real /recall route', async () => {
    await call('/remember', { content: '发布分支总是 main，不是 master。', kind: 'fact' })
    // "发布分支" is a real substring of the tokenised run, not the whole run.
    const result = await call('/recall', { query: '发布分支' }) as { memories: MastermindMemoryRecord[] }
    expect(result.memories.length).toBeGreaterThan(0)
    expect(result.memories[0].content).toContain('发布分支总是')
  })
})

describe('/list_memories', () => {
  it('lists everything with no filters', async () => {
    await call('/remember', { content: 'A', kind: 'fact' })
    await call('/remember', { content: 'B', kind: 'preference' })

    const result = await call('/list_memories', {}) as { memories: MastermindMemoryRecord[] }
    expect(result.memories).toHaveLength(2)
  })

  it('filters by scope and kind', async () => {
    await call('/remember', { content: 'A global fact', kind: 'fact', scope: 'global' })
    await call('/remember', { content: 'A project preference', kind: 'preference', scope: 'project:abc' })

    const result = await call('/list_memories', { scope: 'project:abc' }) as { memories: MastermindMemoryRecord[] }
    expect(result.memories).toHaveLength(1)
    expect(result.memories[0].content).toBe('A project preference')

    const byKind = await call('/list_memories', { kind: 'fact' }) as { memories: MastermindMemoryRecord[] }
    expect(byKind.memories.map((m) => m.content)).toEqual(['A global fact'])
  })
})

describe('/forget', () => {
  it('deletes by exact id', async () => {
    const created = await call('/remember', { content: 'Temporary', kind: 'fact' }) as { memory: MastermindMemoryRecord }
    const notify = vi.fn()
    setTaskApiNotifier(notify)

    const result = await call('/forget', { id: created.memory.id }) as { success: boolean }
    expect(result.success).toBe(true)
    expect(db.getMemory(created.memory.id)).toBeUndefined()
    expect(notify).toHaveBeenCalledWith('mastermind:memory-deleted', { id: created.memory.id })
  })

  it('errors on an id that does not exist', async () => {
    expect(await call('/forget', { id: 'nope' })).toEqual({ error: 'Memory not found' })
  })

  it('deletes the single match for an unambiguous query', async () => {
    await call('/remember', { content: 'Always use pnpm for this repo', kind: 'preference' })
    await call('/remember', { content: 'Deploys happen on Fridays', kind: 'procedure' })

    const result = await call('/forget', { query: 'pnpm' }) as { success: boolean }
    expect(result.success).toBe(true)
    expect(db.listMemories({})).toHaveLength(1)
    expect(db.listMemories({})[0].content).toContain('Fridays')
  })

  it('returns candidates instead of deleting anything for an ambiguous query', async () => {
    // Deliberately low word-overlap with each other (unlike the dedupe test
    // above) so this exercises ambiguous-match handling, not dedupe-merge.
    await call('/remember', { content: 'pnpm handles the frontend repo dependencies', kind: 'preference' })
    await call('/remember', { content: 'The backend repo CI pipeline also runs pnpm but only on release tags', kind: 'procedure' })

    const result = await call('/forget', { query: 'pnpm repo' }) as { ambiguous: boolean; candidates: unknown[] }
    expect(result.ambiguous).toBe(true)
    expect(result.candidates).toHaveLength(2)
    expect(db.listMemories({})).toHaveLength(2)
  })

  it('errors when neither id nor query is given', async () => {
    expect(await call('/forget', {})).toEqual({ error: 'id or query is required' })
  })

  it('errors when a query matches nothing', async () => {
    expect(await call('/forget', { query: 'nothing matches this' })).toEqual({ error: 'No memory matches that query.' })
  })

  describe('regression: non-ASCII / punctuation-only queries must never fall back to deleting an unrelated memory', () => {
    it('a Cyrillic query that matches nothing does not delete the only memory in the scope', async () => {
      await call('/remember', { content: 'Always use pnpm.', kind: 'preference' })
      const result = await call('/forget', { query: 'непонятный запрос' }) as { error?: string }
      expect(result.error).toBe('No memory matches that query.')
      expect(db.listMemories({})).toHaveLength(1)
    })

    it('a CJK query that matches nothing does not delete the only memory in the scope', async () => {
      await call('/remember', { content: 'Always use pnpm.', kind: 'preference' })
      const result = await call('/forget', { query: '完全不相关的查询' }) as { error?: string }
      expect(result.error).toBe('No memory matches that query.')
      expect(db.listMemories({})).toHaveLength(1)
    })

    it('a punctuation-only query does not delete the only memory in the scope', async () => {
      await call('/remember', { content: 'Always use pnpm.', kind: 'preference' })
      const result = await call('/forget', { query: '???!!!...' }) as { error?: string }
      expect(result.error).toBe('No memory matches that query.')
      expect(db.listMemories({})).toHaveLength(1)
    })

    it('a real Cyrillic query still deletes the memory it actually matches', async () => {
      await call('/remember', { content: 'Всегда используй pnpm.', kind: 'preference' })
      const result = await call('/forget', { query: 'используй' }) as { success: boolean }
      expect(result.success).toBe(true)
      expect(db.listMemories({})).toHaveLength(0)
    })

    // Parity with Latin/Cyrillic: forget can act on a genuine, unambiguous
    // CJK partial match (not just a query equal to the whole tokenised run) —
    // the same LIKE fallback that makes /recall find partial CJK phrases.
    it('a real partial CJK query still deletes the single memory it actually matches', async () => {
      await call('/remember', { content: '发布分支总是 main，不是 master。', kind: 'fact' })
      const result = await call('/forget', { query: '发布分支' }) as { success: boolean }
      expect(result.success).toBe(true)
      expect(db.listMemories({})).toHaveLength(0)
    })
  })
})

describe('logSafeRouteBody (log redaction for memory routes)', () => {
  it('never includes the request/response content for a memory route', () => {
    const logged = logSafeRouteBody('/remember', { content: 'Always use pnpm.', kind: 'preference', __memoryToken: 'tok-secret' })
    expect(logged).not.toContain('pnpm')
    expect(logged).not.toContain('tok-secret')
  })

  it('redacts all four memory routes', () => {
    for (const route of ['/remember', '/recall', '/forget', '/list_memories']) {
      expect(logSafeRouteBody(route, { anything: 'here' })).toBe('[redacted: memory route]')
    }
  })

  it('logs other routes normally, unredacted', () => {
    const logged = logSafeRouteBody('/list_tasks', { status: 'not_started' })
    expect(logged).toContain('not_started')
  })
})
