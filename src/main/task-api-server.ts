/**
 * Lightweight HTTP API server for the task-management MCP server.
 * Runs inside the Electron main process so it can use better-sqlite3.
 * The MCP server (spawned by OpenCode with system Node.js) calls these
 * endpoints via fetch, avoiding the native module version mismatch.
 */
import { createServer, type Server as HttpServer } from 'http'
import { CronExpressionParser } from 'cron-parser'
import type { DatabaseManager } from './database'

let server: HttpServer | null = null
let port: number | null = null
let startupPromise: Promise<number> | null = null
let notifyRenderer: ((channel: string, data: unknown) => void) | null = null
let transcriptProvider: ((taskId: string) => Promise<Array<{ role: string; text: string }>>) | null = null

export function getTaskApiPort(): number | null {
  return port
}

/**
 * Waits for the task API server to finish starting.
 * Returns the port number once available.
 */
export async function waitForTaskApiServer(): Promise<number | null> {
  if (port) return port
  if (startupPromise) {
    try {
      return await startupPromise
    } catch (err) {
      console.error('[TaskApiServer] waitForTaskApiServer - startup promise rejected:', err)
      return null
    }
  }
  console.warn('[TaskApiServer] waitForTaskApiServer - no startup promise exists (server not started?)')
  return null
}

export function setTaskApiNotifier(fn: (channel: string, data: unknown) => void): void {
  notifyRenderer = fn
}

export function setTranscriptProvider(fn: (taskId: string) => Promise<Array<{ role: string; text: string }>>): void {
  transcriptProvider = fn
}

export function startTaskApiServer(db: DatabaseManager): Promise<number> {
  if (server && port) return Promise.resolve(port)
  if (startupPromise) return startupPromise

  startupPromise = new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      // CORS not needed — local only
      res.setHeader('Content-Type', 'application/json')

      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', async () => {
        try {
          const url = new URL(req.url || '/', `http://localhost`)
          const route = url.pathname

          // Parse body if present
          let params: Record<string, unknown> = {}
          if (body) {
            try { params = JSON.parse(body) as Record<string, unknown> } catch { /* ignore */ }
          }

          console.log(`[TaskApiServer] → ${route}`, JSON.stringify(params).slice(0, 200))
          const result = await handleRoute(db, route, params)
          const resultStr = JSON.stringify(result)
          console.log(`[TaskApiServer] ← ${route} (${resultStr.length} bytes)`, resultStr.slice(0, 200))
          res.writeHead(200)
          res.end(resultStr)
        } catch (err: unknown) {
          console.error(`[TaskApiServer] ERROR ${req.url}:`, (err as Error).message)
          res.writeHead(500)
          res.end(JSON.stringify({ error: (err as Error).message }))
        }
      })
    })

    // Listen on random available port
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (typeof addr === 'object' && addr) {
        port = addr.port
        console.log(`[TaskApiServer] Started on port ${port}`)
        resolve(port)
      } else {
        reject(new Error('Failed to get server address'))
      }
    })

    server.on('error', (err) => {
      console.error('[TaskApiServer] Server error:', err)
      reject(err)
    })
  })

  return startupPromise
}

export function stopTaskApiServer(): void {
  if (server) {
    server.close()
    server = null
    port = null
  }
}

// ── Route handler ──────────────────────────────────────────────

async function handleRoute(db: DatabaseManager, route: string, params: Record<string, unknown>): Promise<unknown> {
  const rawDb = (db as unknown as { db: import('better-sqlite3').Database }).db // Access the underlying better-sqlite3 instance

  switch (route) {
    case '/list_tasks': {
      // Exclude recurring parent template tasks — they are not actionable tasks
      let query = 'SELECT * FROM tasks WHERE NOT (is_recurring = 1 AND recurrence_parent_id IS NULL)'
      const qParams: unknown[] = []

      if (params.status) { query += ' AND status = ?'; qParams.push(params.status) }
      if (params.priority) { query += ' AND priority = ?'; qParams.push(params.priority) }
      if (params.has_agent !== undefined) {
        query += params.has_agent ? ' AND agent_id IS NOT NULL' : ' AND agent_id IS NULL'
      }
      if (params.agent_id) { query += ' AND agent_id = ?'; qParams.push(params.agent_id) }
      if (params.labels) {
        const labels = params.labels as string[]
        if (labels.length) {
          const conds = labels.map(() => 'labels LIKE ?').join(' OR ')
          query += ` AND (${conds})`
          labels.forEach((l: string) => qParams.push(`%"${l}"%`))
        }
      }

      query += ' ORDER BY created_at DESC'
      if (params.limit) { query += ' LIMIT ?'; qParams.push(params.limit) }

      const tasks = rawDb.prepare(query).all(...qParams) as Record<string, unknown>[]
      tasks.forEach(parseTask)
      return tasks
    }

    case '/create_task': {
      if (!params.title) return { error: 'Title is required' }

      const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
      const now = new Date().toISOString()

      // Support both new cron field and legacy is_recurring + recurrence_pattern
      const isRecurring = params.cron ? 1 : (params.is_recurring ? 1 : 0)
      const recurrencePattern = params.cron
        ? params.cron
        : params.recurrence_pattern
          ? JSON.stringify(params.recurrence_pattern)
          : null

      // Compute next_occurrence_at for recurring tasks
      let nextOccurrenceAt: string | null = null
      if (isRecurring && recurrencePattern) {
        try {
          if (typeof recurrencePattern === 'string' && !recurrencePattern.startsWith('{')) {
            // Cron string
            const interval = CronExpressionParser.parse(recurrencePattern, { currentDate: new Date(now), tz: 'UTC' })
            nextOccurrenceAt = interval.next().toISOString()
          } else {
            // Legacy JSON — parse and compute manually
            const pattern = typeof recurrencePattern === 'string' ? JSON.parse(recurrencePattern) : recurrencePattern
            const [hours, minutes] = pattern.time.split(':').map(Number)
            const nextDate = new Date(now)
            nextDate.setDate(nextDate.getDate() + (pattern.interval || 1))
            nextDate.setHours(hours, minutes, 0, 0)
            nextOccurrenceAt = nextDate.toISOString()
          }
        } catch { /* ignore — scheduler will pick it up */ }
      }

      rawDb.prepare(`
        INSERT INTO tasks (id, title, description, type, priority, status, assignee, due_date, labels, attachments, repos, output_fields, source, agent_id, skill_ids, is_recurring, recurrence_pattern, next_occurrence_at, parent_task_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', 'local', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        params.title,
        params.description || '',
        params.type || 'general',
        params.priority || 'medium',
        'not_started',
        params.assignee || '',
        params.due_date || null,
        JSON.stringify(params.labels || []),
        params.agent_id || null,
        params.skill_ids ? JSON.stringify(params.skill_ids) : null,
        isRecurring,
        recurrencePattern,
        nextOccurrenceAt,
        params.parent_task_id || null,
        now,
        now
      )

      const task = rawDb.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>
      const parsed = parseTask(task)

      // Notify renderer using properly deserialized task (matches WorkfloTask shape)
      if (notifyRenderer) {
        const properTask = db.getTask(id)
        if (properTask) {
          notifyRenderer('task:created', { task: properTask })
        }
      }

      return { success: true, task: parsed }
    }

    case '/get_task': {
      const task = rawDb.prepare('SELECT * FROM tasks WHERE id = ?').get(params.task_id) as Record<string, unknown> | undefined
      if (!task) return { error: 'Task not found' }
      return parseTask(task)
    }

    case '/update_task': {
      const updates: string[] = []
      const qParams: unknown[] = []

      // Normalize legacy 'in_progress' status to 'agent_working'
      if (params.status === 'in_progress') params.status = 'agent_working'

      // When task is in triaging status, skip status changes from the triage agent
      if (params.status) {
        const currentTask = rawDb.prepare('SELECT status FROM tasks WHERE id = ?').get(params.task_id) as { status: string } | undefined
        if (currentTask?.status === 'triaging') {
          // Don't allow triage agent to change status — it will be reset by transitionToIdle
        } else {
          updates.push('status = ?'); qParams.push(params.status)
        }
      }

      if (params.description !== undefined) { updates.push('description = ?'); qParams.push(params.description) }
      if (params.resolution !== undefined) { updates.push('resolution = ?'); qParams.push(params.resolution) }
      if (params.attachments !== undefined) { updates.push('attachments = ?'); qParams.push(JSON.stringify(params.attachments)) }
      if (params.labels !== undefined) { updates.push('labels = ?'); qParams.push(JSON.stringify(params.labels)) }
      if (params.skill_ids !== undefined) { updates.push('skill_ids = ?'); qParams.push(JSON.stringify(params.skill_ids)) }
      if (params.agent_id !== undefined) { updates.push('agent_id = ?'); qParams.push(params.agent_id) }
      if (params.repos !== undefined) {
        const normalizedRepos = Array.isArray(params.repos)
          ? params.repos
          : (typeof params.repos === 'string' && params.repos.length > 0 ? [params.repos] : [])
        updates.push('repos = ?'); qParams.push(JSON.stringify(normalizedRepos))
      }
      if (params.priority) { updates.push('priority = ?'); qParams.push(params.priority) }
      if (params.output_fields !== undefined) { updates.push('output_fields = ?'); qParams.push(JSON.stringify(params.output_fields)) }

      if (updates.length === 0) return { error: 'No updates provided' }

      updates.push('updated_at = ?')
      qParams.push(new Date().toISOString())
      qParams.push(params.task_id)

      const result = rawDb.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...qParams)
      if (result.changes === 0) return { error: 'Task not found' }

      const updated = rawDb.prepare('SELECT * FROM tasks WHERE id = ?').get(params.task_id) as Record<string, unknown>
      const parsedUpdated = parseTask(updated)

      // Notify renderer using properly deserialized task (matches WorkfloTask shape)
      if (notifyRenderer) {
        const properTask = db.getTask(params.task_id as string)
        if (properTask) {
          notifyRenderer('task:updated', { taskId: params.task_id, updates: properTask })
        }
      }

      return { success: true, task: parsedUpdated }
    }

    case '/list_agents': {
      const agents = rawDb.prepare('SELECT * FROM agents ORDER BY created_at ASC').all() as Record<string, unknown>[]
      agents.forEach((a) => { a.config = JSON.parse((a.config as string) || '{}'); a.is_default = !!a.is_default })
      return agents
    }

    case '/list_skills': {
      const skills = rawDb.prepare('SELECT id, name, description, version, confidence, uses, last_used, tags, created_at, updated_at FROM skills WHERE is_deleted = 0 ORDER BY confidence DESC, uses DESC').all() as Record<string, unknown>[]
      skills.forEach((s) => { s.tags = JSON.parse((s.tags as string) || '[]') })
      return skills
    }

    case '/get_skill': {
      const skill = rawDb.prepare('SELECT * FROM skills WHERE id = ? AND is_deleted = 0').get(params.skill_id) as Record<string, unknown> | undefined
      if (!skill) return { error: 'Skill not found' }
      skill.tags = JSON.parse((skill.tags as string) || '[]')
      return skill
    }

    case '/update_skill': {
      const skillUpdates: string[] = []
      const skillParams: unknown[] = []

      if (params.name !== undefined) { skillUpdates.push('name = ?'); skillParams.push(params.name) }
      if (params.description !== undefined) { skillUpdates.push('description = ?'); skillParams.push(params.description) }
      if (params.content !== undefined) { skillUpdates.push('content = ?'); skillParams.push(params.content) }
      if (params.confidence !== undefined) { skillUpdates.push('confidence = ?'); skillParams.push(params.confidence) }
      if (params.tags !== undefined) { skillUpdates.push('tags = ?'); skillParams.push(JSON.stringify(params.tags)) }

      if (skillUpdates.length === 0) return { error: 'No updates provided' }

      skillUpdates.push('version = version + 1')
      skillUpdates.push('updated_at = ?'); skillParams.push(new Date().toISOString())
      skillParams.push(params.skill_id)

      const skillUpdateResult = rawDb.prepare(
        `UPDATE skills SET ${skillUpdates.join(', ')} WHERE id = ? AND is_deleted = 0`
      ).run(...skillParams)

      if (skillUpdateResult.changes === 0) return { error: 'Skill not found' }

      const updatedSkill = rawDb.prepare('SELECT * FROM skills WHERE id = ?').get(params.skill_id) as Record<string, unknown>
      updatedSkill.tags = JSON.parse((updatedSkill.tags as string) || '[]')
      return { success: true, skill: updatedSkill }
    }

    case '/delete_skill': {
      const deleteResult = rawDb.prepare(
        'UPDATE skills SET is_deleted = 1, updated_at = ? WHERE id = ? AND is_deleted = 0'
      ).run(new Date().toISOString(), params.skill_id)

      if (deleteResult.changes === 0) return { error: 'Skill not found' }
      return { success: true }
    }

    case '/find_similar_tasks': {
      const limit = (params.limit as number) || 10

      // ── Build FTS5 MATCH expression from provided keywords ──
      const matchTerms: string[] = []

      // Tokenise keywords into individual words for broad matching
      const tokenize = (s: unknown): string[] =>
        typeof s === 'string'
          ? s.split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/[^a-zA-Z0-9_]/g, ''))
              .filter(Boolean)
          : []

      const titleWords = tokenize(params.title_keywords)
      const descWords = tokenize(params.description_keywords)

      // Weight title matches higher by boosting with column filter
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
        const labels = params.labels as string[]
        labels.forEach((l: string) => {
          const cleaned = l.replace(/[^a-zA-Z0-9_]/g, '')
          if (cleaned) matchTerms.push(`labels:${cleaned}`)
        })
      }

      // If we have search terms, use FTS5 with bm25 ranking
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

        // ── Fallback: if completed_only returned nothing, retry with all statuses ──
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

      // ── No keywords at all — fall back to recent tasks ──
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

    case '/get_task_statistics': {
      switch (params.metric) {
        case 'label_usage': {
          const tasks = rawDb.prepare('SELECT labels FROM tasks').all() as Record<string, unknown>[]
          const counts = new Map<string, number>()
          tasks.forEach((t) => {
            JSON.parse((t.labels as string) || '[]').forEach((l: string) => counts.set(l, (counts.get(l) || 0) + 1))
          })
          return Object.fromEntries(Array.from(counts.entries()).sort((a, b) => b[1] - a[1]))
        }
        case 'agent_workload':
          return rawDb.prepare(`
            SELECT agent_id, COUNT(*) as task_count,
                   SUM(CASE WHEN status = 'agent_working' THEN 1 ELSE 0 END) as active_count
            FROM tasks WHERE agent_id IS NOT NULL GROUP BY agent_id
          `).all()
        case 'priority_distribution': {
          const dist = rawDb.prepare('SELECT priority, COUNT(*) as count FROM tasks GROUP BY priority').all() as Record<string, unknown>[]
          return Object.fromEntries(dist.map((d) => [d.priority, d.count]))
        }
        case 'completion_rate': {
          const stats = rawDb.prepare(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                   SUM(CASE WHEN status = 'agent_working' THEN 1 ELSE 0 END) as in_progress,
                   SUM(CASE WHEN status = 'not_started' THEN 1 ELSE 0 END) as not_started
            FROM tasks
          `).get() as { total: number; completed: number; in_progress: number; not_started: number }
          return { ...stats, completion_rate: stats.total > 0 ? (stats.completed / stats.total * 100).toFixed(1) + '%' : '0%' }
        }
        default:
          return { error: 'Unknown metric' }
      }
    }

    case '/list_repos': {
      // Get distinct repos from historical tasks
      const tasks = rawDb.prepare('SELECT repos FROM tasks WHERE repos IS NOT NULL AND repos != \'[]\'').all() as Record<string, unknown>[]
      const repoSet = new Set<string>()
      tasks.forEach((t) => {
        try {
          const repos = JSON.parse((t.repos as string) || '[]')
          repos.forEach((r: string) => repoSet.add(r))
        } catch { /* ignore */ }
      })

      // Get github_org from settings
      const orgRow = rawDb.prepare('SELECT value FROM settings WHERE key = ?').get('github_org') as { value: string } | undefined
      const githubOrg = orgRow?.value || null

      return { repos: Array.from(repoSet), github_org: githubOrg }
    }

    case '/list_subtasks': {
      if (!params.parent_task_id) return { error: 'parent_task_id is required' }
      const subtasks = rawDb.prepare(
        'SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY sort_order ASC, created_at ASC'
      ).all(params.parent_task_id) as Record<string, unknown>[]
      subtasks.forEach(parseTask)
      return subtasks
    }

    case '/create_subtask': {
      if (!params.parent_task_id) return { error: 'parent_task_id is required' }
      if (!params.title) return { error: 'title is required' }

      // Verify parent task exists
      const parentTask = rawDb.prepare('SELECT id, repos, priority FROM tasks WHERE id = ?').get(params.parent_task_id) as Record<string, unknown> | undefined
      if (!parentTask) return { error: 'Parent task not found' }

      const subtaskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
      const now = new Date().toISOString()

      // Inherit repos from parent if not specified
      const repos = params.repos ? JSON.stringify(params.repos) : (parentTask.repos as string) || '[]'

      // Calculate next sort_order for this parent's subtasks
      const maxOrderRow = rawDb.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) as max_order FROM tasks WHERE parent_task_id = ?'
      ).get(params.parent_task_id) as { max_order: number }
      const nextSortOrder = maxOrderRow.max_order + 1

      const outputFields = params.output_fields ? JSON.stringify(params.output_fields) : '[]'

      rawDb.prepare(`
        INSERT INTO tasks (id, title, description, type, priority, status, assignee, due_date, labels, attachments, repos, output_fields, source, agent_id, skill_ids, parent_task_id, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'not_started', '', NULL, ?, '[]', ?, ?, 'local', ?, ?, ?, ?, ?, ?)
      `).run(
        subtaskId,
        params.title,
        params.description || '',
        params.type || 'general',
        params.priority || parentTask.priority || 'medium',
        JSON.stringify(params.labels || []),
        repos,
        outputFields,
        params.agent_id || null,
        params.skill_ids ? JSON.stringify(params.skill_ids) : null,
        params.parent_task_id,
        nextSortOrder,
        now,
        now
      )

      const subtask = rawDb.prepare('SELECT * FROM tasks WHERE id = ?').get(subtaskId) as Record<string, unknown>
      const parsedSubtask = parseTask(subtask)

      // Notify renderer
      if (notifyRenderer) {
        const properTask = db.getTask(subtaskId)
        if (properTask) {
          notifyRenderer('task:created', { task: properTask })
        }
      }

      return { success: true, task: parsedSubtask }
    }

    case '/reorder_subtasks': {
      if (!params.parent_task_id) return { error: 'parent_task_id is required' }
      if (!Array.isArray(params.subtask_ids)) return { error: 'subtask_ids array is required' }

      const reorderStmt = rawDb.prepare('UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ? AND parent_task_id = ?')
      const now = new Date().toISOString()

      const reorderTxn = rawDb.transaction(() => {
        for (let i = 0; i < (params.subtask_ids as string[]).length; i++) {
          reorderStmt.run(i, now, (params.subtask_ids as string[])[i], params.parent_task_id)
        }
      })
      reorderTxn()

      return { success: true }
    }

    case '/get_session_transcript': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!transcriptProvider) return { error: 'Transcript provider not available' }
      try {
        const transcript = await transcriptProvider(params.task_id as string)
        return { task_id: params.task_id, messages: transcript }
      } catch (err) {
        return { error: `Failed to retrieve transcript: ${(err as Error).message}` }
      }
    }

    default:
      return { error: 'Unknown route' }
  }
}

function parseTask(task: Record<string, unknown>) {
  if (!task) return task
  task.labels = JSON.parse((task.labels as string) || '[]')
  task.skill_ids = JSON.parse((task.skill_ids as string) || '[]')
  task.attachments = JSON.parse((task.attachments as string) || '[]')
  task.output_fields = JSON.parse((task.output_fields as string) || '[]')
  const parsedRepos = JSON.parse((task.repos as string) || '[]')
  task.repos = Array.isArray(parsedRepos) ? parsedRepos : (typeof parsedRepos === 'string' && parsedRepos.length > 0 ? [parsedRepos] : [])
  task.feedback_rating = task.feedback_rating ?? null
  task.feedback_comment = task.feedback_comment ?? null
  return task
}
