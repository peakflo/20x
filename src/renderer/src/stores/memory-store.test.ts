import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MastermindMemory } from '@/types'

const list = vi.fn()
const create = vi.fn()
const update = vi.fn()
const del = vi.fn()
const clearAll = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  memoryApi: {
    list: (...args: unknown[]) => list(...args),
    get: vi.fn(),
    create: (...args: unknown[]) => create(...args),
    update: (...args: unknown[]) => update(...args),
    delete: (...args: unknown[]) => del(...args),
    clearAll: (...args: unknown[]) => clearAll(...args),
    exportToFile: vi.fn(),
    importFromFile: vi.fn()
  }
}))

import { useMemoryStore } from './memory-store'

function makeMemory(overrides: Partial<MastermindMemory> = {}): MastermindMemory {
  return {
    id: 'mem-1',
    scope: 'global',
    kind: 'fact',
    content: 'A fact',
    source: 'user-stated',
    importance: 3,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_used_at: null,
    expires_at: null,
    pinned: false,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useMemoryStore.setState({ memories: [], isLoading: false, error: null })
})

describe('useMemoryStore', () => {
  it('fetchMemories populates the list', async () => {
    list.mockResolvedValue([makeMemory()])
    await useMemoryStore.getState().fetchMemories()
    expect(useMemoryStore.getState().memories).toHaveLength(1)
  })

  it('fetchMemories records an error without throwing', async () => {
    list.mockRejectedValue(new Error('boom'))
    await useMemoryStore.getState().fetchMemories()
    expect(useMemoryStore.getState().error).toContain('boom')
    expect(useMemoryStore.getState().isLoading).toBe(false)
  })

  it('createMemory prepends the new memory', async () => {
    const memory = makeMemory({ id: 'mem-new' })
    create.mockResolvedValue(memory)
    const result = await useMemoryStore.getState().createMemory({ content: 'A fact', kind: 'fact' })
    expect(result).toEqual(memory)
    expect(useMemoryStore.getState().memories[0]).toEqual(memory)
  })

  it('updateMemory replaces the matching entry in place', async () => {
    useMemoryStore.setState({ memories: [makeMemory({ id: 'mem-1', content: 'Old' })] })
    update.mockResolvedValue(makeMemory({ id: 'mem-1', content: 'New' }))
    await useMemoryStore.getState().updateMemory('mem-1', { content: 'New' })
    expect(useMemoryStore.getState().memories[0].content).toBe('New')
  })

  it('deleteMemory removes the entry only on success', async () => {
    useMemoryStore.setState({ memories: [makeMemory({ id: 'mem-1' })] })
    del.mockResolvedValue(true)
    const ok = await useMemoryStore.getState().deleteMemory('mem-1')
    expect(ok).toBe(true)
    expect(useMemoryStore.getState().memories).toHaveLength(0)
  })

  it('deleteMemory leaves the list untouched when the backend reports failure', async () => {
    useMemoryStore.setState({ memories: [makeMemory({ id: 'mem-1' })] })
    del.mockResolvedValue(false)
    const ok = await useMemoryStore.getState().deleteMemory('mem-1')
    expect(ok).toBe(false)
    expect(useMemoryStore.getState().memories).toHaveLength(1)
  })

  it('clearAll(scope) removes only that scope locally', async () => {
    useMemoryStore.setState({
      memories: [makeMemory({ id: 'mem-1', scope: 'global' }), makeMemory({ id: 'mem-2', scope: 'project:abc' })]
    })
    clearAll.mockResolvedValue(1)
    await useMemoryStore.getState().clearAll('project:abc')
    expect(useMemoryStore.getState().memories.map((m) => m.scope)).toEqual(['global'])
  })

  it('restoreMemory (Undo of a delete) re-inserts the memory once', () => {
    const memory = makeMemory({ id: 'mem-1' })
    useMemoryStore.getState().restoreMemory(memory)
    useMemoryStore.getState().restoreMemory(memory)
    expect(useMemoryStore.getState().memories).toHaveLength(1)
  })
})
