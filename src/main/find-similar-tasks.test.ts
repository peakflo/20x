import { describe, it, expect, beforeEach } from 'vitest'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { makeTask } from '../../test/helpers/task-fixtures'
import type { DatabaseManager } from './database'

/**
 * Tests for the /find_similar_tasks FTS5-based search.
 *
 * Since handleRoute is not exported, we replicate its query logic
 * directly against rawDb — the same approach used in the existing
 * task-api-server tests.
 */

let db: DatabaseManager
let rawDb: import('better-sqlite3').Database

beforeEach(() => {
  ;({ db, rawDb } = createTestDb())
})

// ── Helper: mirrors the handleRoute logic for /find_similar_tasks ──

interface FindSimilarParams {
  title_keywords?: string
  description_keywords?: string
  type?: string
  labels?: string[]
  completed_only?: boolean
  limit?: number
}

function parseTask(task: Record<string, unknown>) {
  if (!task) return task
  task.labels = JSON.parse((task.labels as string) || '[]')
  task.skill_ids = JSON.parse((task.skill_ids as string) || '[]')
  task.attachments = JSON.parse((task.attachments as string) || '[]')
  task.output_fields = JSON.parse((task.output_fields as string) || '[]')
  task.repos = JSON.parse((task.repos as string) || '[]')
  task.feedback_rating = task.feedback_rating ?? null
  task.feedback_comment = task.feedback_comment ?? null
  return task
}

function findSimilarTasks(params: FindSimilarParams): Record<string, unknown>[] {
  const limit = params.limit || 10

  const matchTerms: string[] = []

  const tokenize = (s: unknown): string[] =>
    typeof s === 'string'
      ? s.split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/[^a-zA-Z0-9_]/g, ''))
          .filter(Boolean)
      : []

  const titleWords = tokenize(params.title_keywords)
  const descWords = tokenize(params.description_keywords)

  if (titleWords.length) {
    matchTerms.push(...titleWords.map((w) => `title:${w}*`))
  }
  if (descWords.length) {
    matchTerms.push(...descWords.map((w) => `description:${w}*`))
  }
  if (params.type) {
    matchTerms.push(`type:${params.type}`)
  }
  if (params.labels) {
    params.labels.forEach((l: string) => {
      const cleaned = l.replace(/[^a-zA-Z0-9_]/g, '')
      if (cleaned) matchTerms.push(`labels:${cleaned}`)
    })
  }

  if (matchTerms.length > 0) {
    const matchExpr = matchTerms.join(' OR ')
    let ftsQuery = `
      SELECT t.*, bm25(tasks_fts, 10.0, 5.0, 2.0, 1.0) AS rank
      FROM tasks_fts
      JOIN tasks t ON tasks_fts.rowid = t.rowid
      WHERE tasks_fts MATCH ?`
    const qParams: unknown[] = [matchExpr]

    if (params.completed_only) {
      ftsQuery += ' AND t.status = ?'
      qParams.push('completed')
    }

    ftsQuery += ' ORDER BY rank LIMIT ?'
    qParams.push(limit)

    let tasks = rawDb.prepare(ftsQuery).all(...qParams) as Record<string, unknown>[]

    if (tasks.length === 0 && params.completed_only) {
      const fallbackQuery = `
        SELECT t.*, bm25(tasks_fts, 10.0, 5.0, 2.0, 1.0) AS rank
        FROM tasks_fts
        JOIN tasks t ON tasks_fts.rowid = t.rowid
        WHERE tasks_fts MATCH ?
        ORDER BY rank LIMIT ?`
      tasks = rawDb.prepare(fallbackQuery).all(matchExpr, limit) as Record<string, unknown>[]
    }

    tasks.forEach(parseTask)
    return tasks
  }

  let fallbackQuery = 'SELECT * FROM tasks WHERE 1=1'
  const fbParams: unknown[] = []
  if (params.completed_only) {
    fallbackQuery += ' AND status = ?'
    fbParams.push('completed')
  }
  fallbackQuery += ' ORDER BY created_at DESC LIMIT ?'
  fbParams.push(limit)
  const tasks = rawDb.prepare(fallbackQuery).all(...fbParams) as Record<string, unknown>[]
  tasks.forEach(parseTask)
  return tasks
}

// ── Tests ──────────────────────────────────────────────────

describe('/find_similar_tasks - FTS5 search', () => {
  describe('basic keyword matching', () => {
    it('finds tasks by title keywords', () => {
      db.createTask(makeTask({ title: 'Fix login page bug' }))
      db.createTask(makeTask({ title: 'Add payment gateway' }))
      db.createTask(makeTask({ title: 'Update login authentication' }))

      const results = findSimilarTasks({ title_keywords: 'login' })
      expect(results.length).toBe(2)
      expect(results.map((t) => t.title)).toContain('Fix login page bug')
      expect(results.map((t) => t.title)).toContain('Update login authentication')
    })

    it('finds tasks by description keywords', () => {
      db.createTask(makeTask({ title: 'Task A', description: 'Fix the database connection timeout issue' }))
      db.createTask(makeTask({ title: 'Task B', description: 'Update UI styles' }))
      db.createTask(makeTask({ title: 'Task C', description: 'Database migration for new schema' }))

      const results = findSimilarTasks({ description_keywords: 'database' })
      expect(results.length).toBe(2)
      expect(results.map((t) => t.title)).toContain('Task A')
      expect(results.map((t) => t.title)).toContain('Task C')
    })

    it('matches individual words independently (OR logic)', () => {
      db.createTask(makeTask({ title: 'Fix authentication bug' }))
      db.createTask(makeTask({ title: 'Payment gateway timeout' }))
      db.createTask(makeTask({ title: 'Deploy new build' }))

      // "authentication payment" should match both tasks, not require both words
      const results = findSimilarTasks({ title_keywords: 'authentication payment' })
      expect(results.length).toBe(2)
      expect(results.map((t) => t.title)).toContain('Fix authentication bug')
      expect(results.map((t) => t.title)).toContain('Payment gateway timeout')
    })

    it('supports prefix matching', () => {
      db.createTask(makeTask({ title: 'Authentication system overhaul' }))

      // "auth" should match "authentication" via prefix matching
      const results = findSimilarTasks({ title_keywords: 'auth' })
      // "auth" is 4 chars, passes >2 filter, and auth* matches authentication
      expect(results.length).toBe(1)
      expect(results[0].title).toBe('Authentication system overhaul')
    })
  })

  describe('filtering', () => {
    it('filters by completed_only when set', () => {
      db.createTask(makeTask({ title: 'Login bug completed', status: 'completed' }))
      db.createTask(makeTask({ title: 'Login feature in progress', status: 'agent_working' }))

      const completedOnly = findSimilarTasks({ title_keywords: 'login', completed_only: true })
      expect(completedOnly.length).toBe(1)
      expect(completedOnly[0].title).toBe('Login bug completed')
    })

    it('returns all statuses when completed_only is false', () => {
      db.createTask(makeTask({ title: 'Login bug completed', status: 'completed' }))
      db.createTask(makeTask({ title: 'Login feature in progress', status: 'agent_working' }))

      const all = findSimilarTasks({ title_keywords: 'login', completed_only: false })
      expect(all.length).toBe(2)
    })

    it('filters by task type', () => {
      db.createTask(makeTask({ title: 'Fix something', type: 'coding' }))
      db.createTask(makeTask({ title: 'Review something', type: 'review' }))
      db.createTask(makeTask({ title: 'Code another thing', type: 'coding' }))

      const results = findSimilarTasks({ type: 'coding' })
      expect(results.length).toBe(2)
      results.forEach((t) => expect(t.type).toBe('coding'))
    })

    it('filters by labels', () => {
      db.createTask(makeTask({ title: 'Frontend task', labels: ['frontend', 'bug'] }))
      db.createTask(makeTask({ title: 'Backend task', labels: ['backend', 'feature'] }))
      db.createTask(makeTask({ title: 'Another frontend task', labels: ['frontend'] }))

      const results = findSimilarTasks({ labels: ['frontend'] })
      expect(results.length).toBe(2)
    })

    it('respects limit parameter', () => {
      for (let i = 0; i < 15; i++) {
        db.createTask(makeTask({ title: `Bug fix number ${i}` }))
      }

      const results = findSimilarTasks({ title_keywords: 'bug fix', limit: 5 })
      expect(results.length).toBe(5)
    })
  })

  describe('fallback behavior', () => {
    it('falls back to all statuses when completed_only returns empty', () => {
      // Only non-completed tasks exist
      db.createTask(makeTask({ title: 'Login bug', status: 'not_started' }))
      db.createTask(makeTask({ title: 'Login feature', status: 'agent_working' }))

      // Request completed_only — should still get results via fallback
      const results = findSimilarTasks({ title_keywords: 'login', completed_only: true })
      expect(results.length).toBe(2) // Fallback returned non-completed tasks
    })

    it('returns recent tasks when no keywords are provided', () => {
      db.createTask(makeTask({ title: 'First task' }))
      db.createTask(makeTask({ title: 'Second task' }))
      db.createTask(makeTask({ title: 'Third task' }))

      const results = findSimilarTasks({})
      expect(results.length).toBe(3)
    })

    it('returns empty array when database is empty', () => {
      const results = findSimilarTasks({ title_keywords: 'nonexistent' })
      expect(results).toEqual([])
    })
  })

  describe('relevance ranking', () => {
    it('ranks title matches higher than description matches', () => {
      // Task with "login" only in description (not title)
      db.createTask(makeTask({
        title: 'Update profile page',
        description: 'The login flow needs updating for better security'
      }))
      // Task with "login" in title — should rank higher due to title weight 10x
      db.createTask(makeTask({
        title: 'Fix login authentication',
        description: 'Users cannot access the system'
      }))

      const results = findSimilarTasks({ title_keywords: 'login' })
      // Both match — one via title (FTS searches across columns with MATCH)
      expect(results.length).toBeGreaterThanOrEqual(1)
      // BM25 with title weight 10.0 should rank title match first
      expect(results[0].title).toBe('Fix login authentication')
    })

    it('tasks matching more keywords rank higher', () => {
      db.createTask(makeTask({ title: 'Fix login page' }))
      db.createTask(makeTask({ title: 'Fix login page authentication bug' }))
      db.createTask(makeTask({ title: 'Update README' }))

      const results = findSimilarTasks({ title_keywords: 'login authentication bug' })
      expect(results.length).toBe(2) // README should not match
      // Task with more keyword hits should rank first
      expect(results[0].title).toBe('Fix login page authentication bug')
    })
  })

  describe('FTS index sync', () => {
    it('finds newly created tasks immediately', () => {
      const results1 = findSimilarTasks({ title_keywords: 'payment' })
      expect(results1.length).toBe(0)

      db.createTask(makeTask({ title: 'Payment gateway integration' }))

      const results2 = findSimilarTasks({ title_keywords: 'payment' })
      expect(results2.length).toBe(1)
    })

    it('reflects task updates in search results', () => {
      const task = db.createTask(makeTask({ title: 'Original title' }))!

      const before = findSimilarTasks({ title_keywords: 'updated' })
      expect(before.length).toBe(0)

      db.updateTask(task.id, { title: 'Updated title with new keywords' })

      const after = findSimilarTasks({ title_keywords: 'updated' })
      expect(after.length).toBe(1)
    })

    it('removes deleted tasks from search results', () => {
      const task = db.createTask(makeTask({ title: 'Delete me please' }))!

      const before = findSimilarTasks({ title_keywords: 'delete' })
      expect(before.length).toBe(1)

      db.deleteTask(task.id)

      const after = findSimilarTasks({ title_keywords: 'delete' })
      expect(after.length).toBe(0)
    })
  })

  describe('edge cases', () => {
    it('ignores short words (<=2 chars) in keywords', () => {
      db.createTask(makeTask({ title: 'Fix a UI bug' }))

      // "a" is 1 char and "do" is 2 chars — both should be filtered out (<=2 chars)
      // With no valid keywords, falls back to returning recent tasks
      const results = findSimilarTasks({ title_keywords: 'a do' })
      // Both words are <=2 chars so no FTS terms are generated,
      // falls back to returning recent tasks (no keyword matching)
      expect(results.length).toBe(1) // Returns via fallback (recent tasks), not keyword match
    })

    it('handles special characters in keywords gracefully', () => {
      db.createTask(makeTask({ title: 'Fix bug in user-auth module' }))

      // Special chars should be stripped but keywords should still match
      const results = findSimilarTasks({ title_keywords: 'user-auth module' })
      // "user" (after stripping hyphen) should match
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('combines title and description keywords for broader search', () => {
      db.createTask(makeTask({
        title: 'Implement payment system',
        description: 'Integrate Stripe API for checkout flow'
      }))

      const results = findSimilarTasks({
        title_keywords: 'payment',
        description_keywords: 'stripe'
      })
      expect(results.length).toBe(1)
    })

    it('returns parsed JSON fields (labels, repos, etc.)', () => {
      db.createTask(makeTask({
        title: 'Search result format test',
        labels: ['bug', 'frontend'],
        repos: ['org/repo-1']
      }))

      const results = findSimilarTasks({ title_keywords: 'search result format' })
      expect(results.length).toBe(1)
      expect(results[0].labels).toEqual(['bug', 'frontend'])
      expect(results[0].repos).toEqual(['org/repo-1'])
    })
  })
})
