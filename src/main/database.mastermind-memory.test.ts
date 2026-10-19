import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import type { DatabaseManager } from './database'

let db: DatabaseManager

beforeEach(() => {
  ;({ db } = createTestDb())
})

describe('Mastermind memory CRUD', () => {
  it('creates a memory with defaults and retrieves it', () => {
    const created = db.createMemory({ content: 'Always use pnpm.', kind: 'preference' })
    expect(created.id).toBeTruthy()
    expect(created.scope).toBe('global')
    expect(created.source).toBe('user-stated')
    expect(created.importance).toBe(3)
    expect(created.pinned).toBe(false)
    expect(created.last_used_at).toBeNull()

    const fetched = db.getMemory(created.id)
    expect(fetched).toEqual(created)
  })

  it('normalizes an invalid scope to global and clamps importance', () => {
    const created = db.createMemory({ content: 'Fact', kind: 'fact', scope: 'nonsense', importance: 99 })
    expect(created.scope).toBe('global')
    expect(created.importance).toBe(5)
  })

  it('truncates content to the 1000-character limit', () => {
    const created = db.createMemory({ content: 'x'.repeat(2000), kind: 'fact' })
    expect(created.content.length).toBe(1000)
  })

  it('updates a memory and bumps updated_at', async () => {
    const created = db.createMemory({ content: 'Original', kind: 'fact' })
    await new Promise((r) => setTimeout(r, 2))
    const updated = db.updateMemory(created.id, { content: 'Revised', pinned: true })
    expect(updated?.content).toBe('Revised')
    expect(updated?.pinned).toBe(true)
    expect(updated?.created_at).toBe(created.created_at)
    expect(updated!.updated_at >= created.updated_at).toBe(true)
  })

  it('returns undefined when updating a memory that does not exist', () => {
    expect(db.updateMemory('nope', { content: 'x' })).toBeUndefined()
  })

  it('deletes a memory', () => {
    const created = db.createMemory({ content: 'Temporary', kind: 'fact' })
    expect(db.deleteMemory(created.id)).toBe(true)
    expect(db.getMemory(created.id)).toBeUndefined()
    expect(db.deleteMemory(created.id)).toBe(false)
  })

  it('lists memories pinned-first, then by importance, then recency', () => {
    db.createMemory({ content: 'Low importance', kind: 'fact', importance: 1 })
    db.createMemory({ content: 'High importance pinned', kind: 'fact', importance: 2, pinned: true })
    db.createMemory({ content: 'High importance', kind: 'fact', importance: 5 })

    const listed = db.listMemories({})
    expect(listed[0].content).toBe('High importance pinned')
    expect(listed[1].content).toBe('High importance')
    expect(listed[2].content).toBe('Low importance')
  })

  it('excludes expired memories from listMemories and listMemoriesForScopes', () => {
    const expired = db.createMemory({ content: 'Expired note', kind: 'fact', expires_at: '2000-01-01T00:00:00.000Z' })
    const active = db.createMemory({ content: 'Active note', kind: 'fact' })

    const listed = db.listMemories({})
    expect(listed.map((m) => m.id)).toEqual([active.id])
    expect(listed.map((m) => m.id)).not.toContain(expired.id)

    const forScopes = db.listMemoriesForScopes(['global'])
    expect(forScopes.map((m) => m.id)).toEqual([active.id])
  })

  it('still returns an expired memory via getMemory (so Settings can show/export it)', () => {
    const expired = db.createMemory({ content: 'Expired note', kind: 'fact', expires_at: '2000-01-01T00:00:00.000Z' })
    expect(db.getMemory(expired.id)?.content).toBe('Expired note')
  })
})

describe('Mastermind memory scopes', () => {
  it('filters by exact scope', () => {
    db.createMemory({ content: 'Global note', kind: 'fact', scope: 'global' })
    db.createMemory({ content: 'Project note', kind: 'fact', scope: 'project:abc' })
    db.createMemory({ content: 'Repo note', kind: 'fact', scope: 'repo:peakflo/20x' })

    expect(db.listMemories({ scope: 'global' }).map((m) => m.content)).toEqual(['Global note'])
    expect(db.listMemories({ scope: 'project:abc' }).map((m) => m.content)).toEqual(['Project note'])
    expect(db.listMemories({ scope: 'repo:peakflo/20x' }).map((m) => m.content)).toEqual(['Repo note'])
  })

  it('listMemoriesForScopes returns the union of the given scopes only', () => {
    db.createMemory({ content: 'Global note', kind: 'fact', scope: 'global' })
    db.createMemory({ content: 'Project note', kind: 'fact', scope: 'project:abc' })
    db.createMemory({ content: 'Other project note', kind: 'fact', scope: 'project:xyz' })

    const result = db.listMemoriesForScopes(['global', 'project:abc'])
    expect(result.map((m) => m.content).sort()).toEqual(['Global note', 'Project note'])
  })

  it('filters by kind', () => {
    db.createMemory({ content: 'A preference', kind: 'preference' })
    db.createMemory({ content: 'A decision', kind: 'decision' })

    expect(db.listMemories({ kind: 'decision' }).map((m) => m.content)).toEqual(['A decision'])
  })
})

describe('Mastermind memory dedupe (via listMemoriesForDedupe)', () => {
  it('only returns candidates in the same scope and kind', () => {
    db.createMemory({ content: 'Always use pnpm', kind: 'preference', scope: 'global' })
    db.createMemory({ content: 'Always use pnpm', kind: 'fact', scope: 'global' }) // different kind
    db.createMemory({ content: 'Always use pnpm', kind: 'preference', scope: 'project:abc' }) // different scope

    const candidates = db.listMemoriesForDedupe('global', 'preference')
    expect(candidates).toHaveLength(1)
    expect(candidates[0].content).toBe('Always use pnpm')
  })

  it('excludes expired candidates', () => {
    db.createMemory({ content: 'Expired', kind: 'preference', expires_at: '2000-01-01T00:00:00.000Z' })
    expect(db.listMemoriesForDedupe('global', 'preference')).toHaveLength(0)
  })
})

describe('Mastermind memory full-text search (searchMemories)', () => {
  it('finds a memory by a word in its content', () => {
    db.createMemory({ content: 'Always use pnpm, never npm or yarn.', kind: 'preference' })
    db.createMemory({ content: 'Deploys happen on Fridays at 5pm.', kind: 'procedure' })

    const results = db.searchMemories('pnpm')
    expect(results.map((m) => m.content)).toContain('Always use pnpm, never npm or yarn.')
    expect(results.map((m) => m.content)).not.toContain('Deploys happen on Fridays at 5pm.')
  })

  it('falls back to listMemories for an empty/punctuation-only query instead of matching nothing', () => {
    db.createMemory({ content: 'Always use pnpm', kind: 'preference' })
    expect(db.searchMemories('   ')).toHaveLength(1)
    expect(db.searchMemories('!!!')).toHaveLength(1)
  })

  it('respects scope and kind filters', () => {
    db.createMemory({ content: 'Use pnpm for this project', kind: 'preference', scope: 'project:abc' })
    db.createMemory({ content: 'Use pnpm globally', kind: 'preference', scope: 'global' })

    const results = db.searchMemories('pnpm', { scope: 'project:abc' })
    expect(results.map((m) => m.content)).toEqual(['Use pnpm for this project'])
  })

  it('stays in sync after an update (FTS content trigger)', () => {
    const created = db.createMemory({ content: 'Original searchable text', kind: 'fact' })
    db.updateMemory(created.id, { content: 'Completely different wording' })

    expect(db.searchMemories('Original')).toHaveLength(0)
    expect(db.searchMemories('Completely').map((m) => m.id)).toEqual([created.id])
  })

  it('stays in sync after a delete (FTS content trigger)', () => {
    const created = db.createMemory({ content: 'Soon to be forgotten', kind: 'fact' })
    db.deleteMemory(created.id)
    expect(db.searchMemories('forgotten')).toHaveLength(0)
  })
})

describe('Mastermind memory usage tracking', () => {
  it('touchMemoriesUsed sets last_used_at for the given ids only', () => {
    const a = db.createMemory({ content: 'A', kind: 'fact' })
    const b = db.createMemory({ content: 'B', kind: 'fact' })

    db.touchMemoriesUsed([a.id])

    expect(db.getMemory(a.id)?.last_used_at).not.toBeNull()
    expect(db.getMemory(b.id)?.last_used_at).toBeNull()
  })

  it('is a no-op for an empty id list', () => {
    expect(() => db.touchMemoriesUsed([])).not.toThrow()
  })
})

describe('Mastermind memory clearAllMemories', () => {
  it('clears everything when no scope is given', () => {
    db.createMemory({ content: 'A', kind: 'fact', scope: 'global' })
    db.createMemory({ content: 'B', kind: 'fact', scope: 'project:abc' })

    const removed = db.clearAllMemories()
    expect(removed).toBe(2)
    expect(db.listMemories({})).toHaveLength(0)
  })

  it('clears only the given scope', () => {
    db.createMemory({ content: 'A', kind: 'fact', scope: 'global' })
    db.createMemory({ content: 'B', kind: 'fact', scope: 'project:abc' })

    const removed = db.clearAllMemories('project:abc')
    expect(removed).toBe(1)
    expect(db.listMemories({}).map((m) => m.scope)).toEqual(['global'])
  })
})

describe('Mastermind memory export / import', () => {
  it('round-trips every field through export and import', () => {
    const created = db.createMemory({ content: 'Round trip me', kind: 'decision', importance: 5, pinned: true })
    const exported = db.exportMemories()
    expect(exported).toHaveLength(1)
    expect(exported[0]).toEqual(created)
  })

  it('includes expired memories in the export', () => {
    db.createMemory({ content: 'Expired', kind: 'fact', expires_at: '2000-01-01T00:00:00.000Z' })
    expect(db.exportMemories()).toHaveLength(1)
  })

  it('imports valid records and skips invalid ones', () => {
    const result = db.importMemories([
      { id: 'imported-1', content: 'Imported fact', kind: 'fact', source: 'imported', importance: 4, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', pinned: true },
      { content: '', kind: 'fact' }, // empty content — skipped
      { content: 'bad kind', kind: 'not-a-kind' }, // invalid kind — skipped
      'not even an object'
    ])
    expect(result).toEqual({ imported: 1, skipped: 3 })
    const imported = db.getMemory('imported-1')
    expect(imported?.content).toBe('Imported fact')
    expect(imported?.pinned).toBe(true)
  })

  it('upserts by id — importing the same export twice does not duplicate', () => {
    db.createMemory({ content: 'Original', kind: 'fact' })
    const exported = db.exportMemories()

    db.importMemories(exported)
    db.importMemories(exported)

    expect(db.listMemories({})).toHaveLength(1)
  })

  it('generates a fresh id for an import record with no id', () => {
    const result = db.importMemories([{ content: 'No id given', kind: 'fact' }])
    expect(result.imported).toBe(1)
    expect(db.listMemories({})[0].id).toBeTruthy()
  })
})
