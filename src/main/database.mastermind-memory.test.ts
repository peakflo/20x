import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { DatabaseManager } from './database'

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

  describe('non-ASCII tokenising (\\p{L}\\p{N}, not just a-z0-9)', () => {
    it('finds a memory written in Cyrillic by a real word in it', () => {
      db.createMemory({ content: 'Всегда используй pnpm, а не npm.', kind: 'preference' })
      db.createMemory({ content: 'Деплои происходят по пятницам.', kind: 'procedure' })

      const results = db.searchMemories('используй')
      expect(results.map((m) => m.content)).toContain('Всегда используй pnpm, а не npm.')
      expect(results.map((m) => m.content)).not.toContain('Деплои происходят по пятницам.')
    })

    it('does not strip a Cyrillic query to nothing and silently fall back to the full list', () => {
      db.createMemory({ content: 'Always use pnpm.', kind: 'preference' })
      db.createMemory({ content: 'Deploys happen on Fridays.', kind: 'procedure' })

      // A real, specific Cyrillic query that matches neither memory must not
      // match both of them via the old ASCII-only tokeniser stripping it to "".
      const results = db.searchMemories('совершенно другой запрос', {}, { allowFallbackToList: false })
      expect(results).toHaveLength(0)
    })

    it('finds a memory written in CJK by its exact tokenised run (unicode61 has no CJK segmentation)', () => {
      db.createMemory({ content: '发布分支总是 main，不是 master。', kind: 'fact' })
      const results = db.searchMemories('发布分支总是')
      expect(results).toHaveLength(1)
    })

    // Round-2 review fix: unicode61 treats a whole contiguous CJK run as ONE
    // token, so a true substring of a longer run used to never match via
    // FTS MATCH — only a query equal to the ENTIRE tokenised run worked, even
    // though a user typing a partial phrase expects it to find the memory
    // (exactly the search experience Latin/Cyrillic queries already get at
    // the word level). searchMemories now falls back to a LIKE substring
    // scan when the query contains CJK text and FTS found nothing.
    it('finds a memory by a genuine PARTIAL CJK phrase, not just the whole tokenised run', () => {
      db.createMemory({ content: '发布分支总是 main，不是 master。', kind: 'fact' })

      // "发布分支" is a real substring of the tokenised run "发布分支总是", but
      // is not the whole run — the case that used to return zero matches.
      const results = db.searchMemories('发布分支')
      expect(results).toHaveLength(1)
      expect(results[0].content).toContain('发布分支总是')
    })

    it('a partial CJK phrase that is not actually contained anywhere still finds nothing', () => {
      db.createMemory({ content: '发布分支总是 main，不是 master。', kind: 'fact' })

      const results = db.searchMemories('完全不相关', {}, { allowFallbackToList: false })
      expect(results).toHaveLength(0)
    })

    it('a Japanese partial phrase (Katakana/Hiragana) also finds its memory via the LIKE fallback', () => {
      db.createMemory({ content: 'デプロイは金曜日に行われます。', kind: 'procedure' })

      const results = db.searchMemories('デプロイ')
      expect(results.map((m) => m.content)).toContain('デプロイは金曜日に行われます。')
    })
  })

  describe('allowFallbackToList option', () => {
    it('defaults to true: an empty query falls back to the plain list', () => {
      db.createMemory({ content: 'Always use pnpm', kind: 'preference' })
      expect(db.searchMemories('')).toHaveLength(1)
    })

    it('false: an empty/punctuation-only query returns nothing instead of the plain list', () => {
      db.createMemory({ content: 'Always use pnpm', kind: 'preference' })
      expect(db.searchMemories('', {}, { allowFallbackToList: false })).toHaveLength(0)
      expect(db.searchMemories('???', {}, { allowFallbackToList: false })).toHaveLength(0)
    })

    it('false: a real query that matches something still returns it normally', () => {
      db.createMemory({ content: 'Always use pnpm', kind: 'preference' })
      expect(db.searchMemories('pnpm', {}, { allowFallbackToList: false })).toHaveLength(1)
    })
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
    expect(result).toEqual({ imported: 1, skipped: 3, duplicates: 0 })
    const imported = db.getMemory('imported-1')
    expect(imported?.content).toBe('Imported fact')
  })

  it('does not overwrite an existing row with the same id — a duplicate is skipped, not upserted', () => {
    db.createMemory({ content: 'Original', kind: 'fact' })
    const exported = db.exportMemories()
    const [existing] = exported

    const result = db.importMemories([{ ...existing, content: 'Attempted overwrite' }])

    expect(result).toEqual({ imported: 0, skipped: 0, duplicates: 1 })
    expect(db.getMemory(existing.id)?.content).toBe('Original')
  })

  it('importing the same export twice does not duplicate (the second pass is all duplicates)', () => {
    db.createMemory({ content: 'Original', kind: 'fact' })
    const exported = db.exportMemories()

    const first = db.importMemories(exported)
    const second = db.importMemories(exported)

    expect(first).toEqual({ imported: 0, skipped: 0, duplicates: 1 }) // the record already exists from createMemory above
    expect(second).toEqual({ imported: 0, skipped: 0, duplicates: 1 })
    expect(db.listMemories({})).toHaveLength(1)
  })

  it('generates a fresh id for an import record with no id', () => {
    const result = db.importMemories([{ content: 'No id given', kind: 'fact' }])
    expect(result.imported).toBe(1)
    expect(db.listMemories({})[0].id).toBeTruthy()
  })

  it('refuses to import something that looks like a credential', () => {
    const result = db.importMemories([{ content: 'api_key: sk-ant-abcdefghijklmnopqrstuvwxyz0123456789', kind: 'fact' }])
    expect(result).toEqual({ imported: 0, skipped: 1, duplicates: 0 })
    expect(db.listMemories({})).toHaveLength(0)
  })

  it('caps the number of records a single import processes', () => {
    const many = Array.from({ length: DatabaseManager.MAX_IMPORT_RECORDS + 10 }, (_, i) => ({ content: `Memory ${i}`, kind: 'fact' }))
    const result = db.importMemories(many)
    expect(result.imported).toBe(DatabaseManager.MAX_IMPORT_RECORDS)
    expect(result.skipped).toBe(10)
  })

  describe('pinned/source metadata is stripped by default (an imported memory should not arrive pre-trusted)', () => {
    it('does not import as pinned unless keepPinned is passed', () => {
      const result = db.importMemories([{ content: 'Should not be pinned', kind: 'fact', pinned: true }])
      const [imported] = db.listMemories({})
      expect(result.imported).toBe(1)
      expect(imported.pinned).toBe(false)
    })

    it('imports as pinned when keepPinned is passed', () => {
      db.importMemories([{ content: 'Should be pinned', kind: 'fact', pinned: true }], { keepPinned: true })
      expect(db.listMemories({})[0].pinned).toBe(true)
    })

    it('does not keep the original source unless keepSource is passed', () => {
      db.importMemories([{ content: 'x', kind: 'fact', source: 'user-stated' }])
      expect(db.listMemories({})[0].source).toBe('imported')
    })

    it('keeps the original source when keepSource is passed', () => {
      db.importMemories([{ content: 'x', kind: 'fact', source: 'user-stated' }], { keepSource: true })
      expect(db.listMemories({})[0].source).toBe('user-stated')
    })
  })
})
