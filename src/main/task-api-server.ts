/**
 * Lightweight HTTP API server for task-management tools.
 * Runs inside the Electron main process so it can use better-sqlite3.
 *
 * It serves two things:
 *   - one plain JSON route per tool, and
 *   - the MCP endpoint at /mcp, which agent sessions connect to directly.
 *
 * Sessions no longer spawn a task-management-mcp.js child process. That child
 * only forwarded calls to this same server, so it was pure overhead, and one
 * copy per session stayed alive for as long as the agent CLI did.
 */
import { createServer, type Server as HttpServer } from 'http'
import { CronExpressionParser } from 'cron-parser'
import type { DatabaseManager } from './database'
import { TASK_MCP_PATH, handleTaskMcpRequest } from './task-mcp-endpoint'
import { TaskStatus } from '../shared/constants'
import { ArtifactType } from '../shared/artifacts'
import type { AgentManager } from './agent-manager'
import {
  UI_CANVAS_MAX_ZOOM,
  UI_CANVAS_MIN_ZOOM,
  UI_COMMAND_CHANNEL,
  isUiCanvasViewMode,
  isUiOpenTaskTarget,
  isUiViewName,
  type UiCommand,
  type UiOpenTaskTarget
} from '../shared/ui-commands'
import { buildSimilarTasksQuery } from './task-search'
import {
  createRegisteredTaskArtifact,
  editRegisteredTaskArtifactFile,
  listRegisteredTaskArtifacts,
  readRegisteredTaskArtifactFile,
  writeRegisteredTaskArtifactFile
} from './artifacts'
import { panelBrowserBroker } from './panel-browser-broker'

let server: HttpServer | null = null
let port: number | null = null
let startupPromise: Promise<number> | null = null
let notifyRenderer: ((channel: string, data: unknown) => void) | null = null
let transcriptProvider: ((taskId: string) => Promise<Array<{ role: string; text: string }>>) | null = null
type TaskApiAgentController = Pick<
  AgentManager,
  | 'startTask'
  | 'notifyParentOfSubtaskCompletion'
  | 'sendByTaskId'
  | 'respondToPermission'
  | 'stopByTaskId'
  | 'findSessionByTaskId'
  | 'getSessionStatus'
  | 'getActiveSessionsForTask'
>

let agentController: TaskApiAgentController | null = null

/**
 * What the renderer is showing. It is pushed on change and cached here, so a
 * tool call never has to wait for a round trip to the window.
 */
let uiState: Record<string, unknown> = { available: false }

export function setTaskApiUiState(state: Record<string, unknown> | null): void {
  // Null clears it. A closed window must not keep reporting a stale screen.
  uiState = state ? { ...state, available: true, updatedAt: Date.now() } : { available: false }
}

/** The canvas panels the window last published, or none when it published none. */
function readCanvasPanels(): Array<{ taskId: string | null }> {
  const canvas = uiState.canvas as { panels?: Array<{ taskId: string | null }> } | undefined
  return Array.isArray(canvas?.panels) ? canvas.panels : []
}

/**
 * Where "open this task" should send the user when the caller did not say.
 *
 * It follows the screen: a user looking at the canvas means the canvas, and a
 * user on the dashboard means the dialog that keeps them there. Anything else
 * is the full task view.
 */
function resolveOpenTaskTarget(): 'workspace' | 'canvas' | 'modal' {
  const view = typeof uiState.view === 'string' ? uiState.view : null
  if (view === 'canvas') return 'canvas'
  if (view === 'dashboard') return 'modal'
  return 'workspace'
}

/** Refuses when that task has no panel, so a move cannot silently do nothing. */
function requireCanvasPanel(taskId: string): { error: string } | null {
  if (readCanvasPanels().some((panel) => panel.taskId === taskId)) return null
  return { error: 'That task has no panel on the canvas. Open it there first.' }
}

/**
 * Pushes one command to the window.
 *
 * A command that reaches no window is a failure, not a success: an agent that
 * is told "done" would go on to describe a screen the user never saw.
 */
function sendUiCommand(command: UiCommand): { success: true; command: string } | { error: string } {
  if (!uiState.available) return { error: 'No 20x window is open' }
  if (!notifyRenderer) return { error: 'The window cannot be reached' }
  notifyRenderer(UI_COMMAND_CHANNEL, command)
  return { success: true, command: command.kind }
}

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

/**
 * Runs one auto-start / auto-complete reconciliation pass.
 *
 * A caller reaching this server has no window, so nothing in the renderer will
 * act on the `auto_start_agent` / `auto_complete_without_review` flags it just
 * set. Poking the main-process scheduler keeps those flags immediate rather
 * than leaving them until its next 60s tick.
 */
let taskAutomationTrigger: (() => void) | null = null

export function setTaskAutomationTrigger(fn: (() => void) | null): void {
  taskAutomationTrigger = fn
}

function triggerTaskAutomation(): void {
  try {
    taskAutomationTrigger?.()
  } catch (err) {
    console.error('[TaskAPI] Task automation trigger failed:', err)
  }
}

export function setTranscriptProvider(fn: (taskId: string) => Promise<Array<{ role: string; text: string }>>): void {
  transcriptProvider = fn
}

export function setTaskApiAgentController(controller: TaskApiAgentController | null): void {
  agentController = controller
}

export function startTaskApiServer(db: DatabaseManager): Promise<number> {
  if (server && port) return Promise.resolve(port)
  if (startupPromise) return startupPromise

  startupPromise = new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', async () => {
        try {
          const url = new URL(req.url || '/', `http://localhost`)
          const route = url.pathname

          // The MCP endpoint speaks JSON-RPC and sets its own headers, so it
          // must be served before anything below assumes a plain JSON route.
          // It replaces the per-session task-management-mcp.js child process.
          if (route === TASK_MCP_PATH) {
            await handleTaskMcpRequest(req, res, url, body, (mcpRoute, params) =>
              handleRoute(db, mcpRoute, params)
            )
            return
          }

          // CORS not needed — local only
          res.setHeader('Content-Type', 'application/json')

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
          // The MCP endpoint may have written its headers already; writing them
          // twice throws and would take the whole server down.
          if (res.headersSent) {
            res.end()
            return
          }
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
  startupPromise = null
}

// ── Route handler ──────────────────────────────────────────────

/** Exported so the routes can be tested without starting an HTTP server. */
export async function handleRoute(db: DatabaseManager, route: string, params: Record<string, unknown>): Promise<unknown> {
  const rawDb = (db as unknown as { db: import('better-sqlite3').Database }).db // Access the underlying better-sqlite3 instance

  switch (route) {
    case '/create_artifact': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      const title = typeof params.title === 'string' ? params.title : ''
      const type = typeof params.type === 'string' ? params.type as ArtifactType : ArtifactType.FILE
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      if (!title.trim()) return { error: 'Artifact title is required' }
      if (!Object.values(ArtifactType).includes(type) || type === ArtifactType.PR) return { error: 'Unsupported artifact type' }
      const artifact = await createRegisteredTaskArtifact(db.getWorkspaceDir(taskId), taskId, { title, type })
      return { artifact }
    }

    case '/list_artifacts': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      return listRegisteredTaskArtifacts(db.getWorkspaceDir(taskId), taskId)
    }

    case '/write_artifact_file': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      if (typeof params.artifact_id !== 'string' || typeof params.filename !== 'string' || typeof params.content !== 'string') {
        return { error: 'artifact_id, filename, and content are required' }
      }
      const artifact = await writeRegisteredTaskArtifactFile(db.getWorkspaceDir(taskId), taskId, {
        artifactId: params.artifact_id,
        filename: params.filename,
        content: params.content,
        encoding: params.encoding === 'base64' ? 'base64' : 'utf8',
        preview: params.preview === true
      })
      notifyRenderer?.('artifact:updated', { taskId, artifact })
      return { artifact }
    }

    case '/edit_artifact_file': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      if (
        typeof params.artifact_id !== 'string'
        || typeof params.filename !== 'string'
        || typeof params.text_to_replace !== 'string'
        || typeof params.replacement !== 'string'
      ) return { error: 'artifact_id, filename, text_to_replace, and replacement are required' }
      const artifact = await editRegisteredTaskArtifactFile(db.getWorkspaceDir(taskId), taskId, {
        artifactId: params.artifact_id,
        filename: params.filename,
        textToReplace: params.text_to_replace,
        replacement: params.replacement
      })
      notifyRenderer?.('artifact:updated', { taskId, artifact })
      return { artifact }
    }

    case '/read_artifact_file': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      if (typeof params.artifact_id !== 'string' || typeof params.filename !== 'string') {
        return { error: 'artifact_id and filename are required' }
      }
      return readRegisteredTaskArtifactFile(
        db.getWorkspaceDir(taskId),
        taskId,
        params.artifact_id,
        params.filename
      )
    }

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
        INSERT INTO tasks (id, title, description, type, priority, status, assignee, due_date, labels, attachments, repos, output_fields, source, agent_id, skill_ids, is_recurring, recurrence_pattern, next_occurrence_at, parent_task_id, auto_start_agent, auto_complete_without_review, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        params.auto_start_agent === true ? 1 : 0,
        params.auto_complete_without_review === true ? 1 : 0,
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

      if (params.auto_start_agent === true) triggerTaskAutomation()

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
      // Lets a caller with no window hand the task straight to its agent.
      if (params.auto_start_agent !== undefined) {
        updates.push('auto_start_agent = ?')
        qParams.push(params.auto_start_agent === true ? 1 : 0)
      }
      // Lets a caller with no window make a task finish by itself.
      if (params.auto_complete_without_review !== undefined) {
        updates.push('auto_complete_without_review = ?')
        qParams.push(params.auto_complete_without_review === true ? 1 : 0)
      }
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

      // A status move — most importantly into ready_for_review — is exactly
      // when an auto-complete flag has to be honoured.
      if (
        params.status !== undefined ||
        params.auto_start_agent !== undefined ||
        params.auto_complete_without_review !== undefined
      ) {
        triggerTaskAutomation()
      }

      // Event-driven coordinator wake-up: when a subtask is moved to a terminal
      // state (by its agent or a sibling), resume the idle parent coordinator
      // instead of relying on it staying resident and polling for child status.
      const newStatus = params.status as string | undefined
      const parentTaskId = updated.parent_task_id as string | null
      if (
        parentTaskId &&
        (newStatus === TaskStatus.ReadyForReview || newStatus === TaskStatus.Completed) &&
        agentController?.notifyParentOfSubtaskCompletion
      ) {
        agentController.notifyParentOfSubtaskCompletion(parentTaskId, params.task_id as string).catch((err) => {
          console.error(`[TaskAPI] Failed to wake parent ${parentTaskId} after subtask ${params.task_id} update:`, err)
        })
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
      // Stemming (porter tokenizer) plus synonym expansion happen in here, so
      // near-miss wording still finds the relevant history. See task-search.ts.
      const query = buildSimilarTasksQuery(params)

      // If we have search terms, use FTS5 with bm25 ranking
      if (query) {
        // Tasks matching the caller's literal wording sort ahead of ones found
        // only through a synonym, because BM25 scores the two alike and would
        // otherwise let a loose match crowd a real one out of the limit.
        // Ranking stays BM25 within each tier.
        const tier = query.exactMatch
          ? `CASE WHEN tasks_fts.rowid IN
               (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?) THEN 0 ELSE 1 END`
          : '0'
        const selectClause = `
          SELECT t.*, bm25(tasks_fts, 10.0, 5.0, 2.0, 1.0) AS rank, ${tier} AS exact_tier
          FROM tasks_fts
          JOIN tasks t ON tasks_fts.rowid = t.rowid
          WHERE tasks_fts MATCH ?`
        // Bind order follows the SQL text: the tier subquery precedes the WHERE.
        const baseParams: unknown[] = query.exactMatch
          ? [query.exactMatch, query.match]
          : [query.match]

        let ftsQuery = selectClause
        const qParams: unknown[] = [...baseParams]

        if (params.completed_only) {
          ftsQuery += ' AND t.status = ?'
          qParams.push('completed')
        }

        ftsQuery += ' ORDER BY exact_tier, rank LIMIT ?'
        qParams.push(limit)

        let tasks = rawDb.prepare(ftsQuery).all(...qParams) as Record<string, unknown>[]

        // ── Fallback: if completed_only returned nothing, retry with all statuses ──
        if (tasks.length === 0 && params.completed_only) {
          const fallbackQuery = `${selectClause} ORDER BY exact_tier, rank LIMIT ?`
          tasks = rawDb.prepare(fallbackQuery).all(...baseParams, limit) as Record<string, unknown>[]
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

    // ── Reading the live state ────────────────────────────────
    // A task row cannot answer these. `waiting_approval` is a session state and
    // is never written to the task record, so a task blocked on the user looks
    // exactly like a task that is running.

    case '/get_messages': {
      if (!params.task_id) return { error: 'task_id is required' }
      const taskId = String(params.task_id)
      const limit = Math.min(Number(params.limit) || 20, 200)
      const includeTools = params.include_tools === true
      const role = params.role ? String(params.role) : null

      let parts = db.getTranscriptParts(taskId)
      // Tool output is enormous and is rarely what a question is about, so it
      // is left out unless it is asked for. This keeps a reply readable.
      if (!includeTools) {
        parts = parts.filter((part) => part.role === 'user' || part.role === 'assistant')
        parts = parts.filter((part) => !part.partType || part.partType === 'text')
      }
      if (role) parts = parts.filter((part) => part.role === role)

      // Newest first, and page backwards with the cursor of the oldest row
      // returned. A sequence number stays correct while the agent keeps writing.
      const ordered = [...parts].sort((a, b) => b.seq - a.seq)
      const before = params.before_seq !== undefined ? Number(params.before_seq) : null
      const page = (before === null ? ordered : ordered.filter((part) => part.seq < before)).slice(0, limit)

      return {
        task_id: taskId,
        messages: page.map((part) => ({
          seq: part.seq,
          role: part.role,
          type: part.partType ?? 'text',
          content: part.content,
          created_at: new Date(part.createdAt).toISOString()
        })),
        next_before_seq: page.length === limit ? page[page.length - 1].seq : null,
        total_available: ordered.length
      }
    }

    case '/get_session_status': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!agentController) return { error: 'Agent controller not available' }
      const taskId = String(params.task_id)
      const task = db.getTask(taskId)
      if (!task) return { error: 'Task not found' }

      const found = agentController.findSessionByTaskId(taskId)
      const live = found ? agentController.getSessionStatus(found.sessionId) : null
      return {
        task_id: taskId,
        title: task.title,
        // The stored status of the task, which survives a restart.
        task_status: task.status,
        // The live state of the agent session, which does not.
        session_status: live?.status ?? 'none',
        session_id: found?.sessionId ?? null,
        agent_id: task.agent_id,
        waiting_for_you: live?.status === 'waiting_approval'
      }
    }

    case '/list_pending_approvals': {
      if (!agentController) return { error: 'Agent controller not available' }
      const waiting = db
        .getTasks()
        .map((task) => {
          const found = agentController!.findSessionByTaskId(task.id)
          if (!found) return null
          const live = agentController!.getSessionStatus(found.sessionId)
          if (live?.status !== 'waiting_approval') return null
          return { task_id: task.id, title: task.title, session_id: found.sessionId, agent_id: task.agent_id }
        })
        .filter(Boolean)
      return { pending: waiting, count: waiting.length }
    }

    case '/get_recent_activity': {
      const limit = Math.min(Number(params.limit) || 20, 100)
      const since = params.since ? Date.parse(String(params.since)) : 0
      const active = db
        .getTasks()
        .filter((task) => Date.parse(task.updated_at) > since)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
        .slice(0, limit)
        .map((task) => {
          const found = agentController?.findSessionByTaskId(task.id)
          const live = found ? agentController?.getSessionStatus(found.sessionId) : null
          return {
            task_id: task.id,
            title: task.title,
            status: task.status,
            session_status: live?.status ?? 'none',
            updated_at: task.updated_at
          }
        })
      return { activity: active, count: active.length }
    }

    case '/get_ui_state': {
      // Pushed by the renderer on change, so this never waits for the window.
      return uiState
    }

    // ── Driving the window ────────────────────────────────────
    // Each of these validates the premise here and then pushes one command.
    // Nothing is invented: when no window has published a screen, the call
    // fails rather than reporting an action that reached nobody.

    case '/navigate': {
      if (!isUiViewName(params.view)) {
        return { error: 'view must be one of dashboard, tasks, canvas, skills, settings' }
      }
      return sendUiCommand({
        kind: 'navigate',
        view: params.view,
        settingsTab: params.settings_tab ? String(params.settings_tab) : undefined
      })
    }

    case '/open_task': {
      if (!params.task_id) return { error: 'task_id is required' }
      const taskId = String(params.task_id)
      const task = db.getTask(taskId)
      if (!task) return { error: 'Task not found' }

      const requested: UiOpenTaskTarget = params.where === undefined ? 'auto' : String(params.where) as UiOpenTaskTarget
      if (!isUiOpenTaskTarget(requested)) {
        return { error: 'where must be one of auto, workspace, canvas, modal' }
      }
      const where = requested === 'auto' ? resolveOpenTaskTarget() : requested
      const result = sendUiCommand({ kind: 'open_task', taskId, where })
      return 'error' in result ? result : { ...result, where, task_title: task.title }
    }

    case '/move_task_panel': {
      if (!params.task_id) return { error: 'task_id is required' }
      const x = Number(params.x)
      const y = Number(params.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'x and y must be numbers' }
      const taskId = String(params.task_id)
      if (!db.getTask(taskId)) return { error: 'Task not found' }
      const missing = requireCanvasPanel(taskId)
      if (missing) return missing
      return sendUiCommand({ kind: 'move_task_panel', taskId, x, y })
    }

    case '/close_task_panel': {
      if (!params.task_id) return { error: 'task_id is required' }
      const taskId = String(params.task_id)
      const missing = requireCanvasPanel(taskId)
      if (missing) return missing
      return sendUiCommand({ kind: 'close_task_panel', taskId })
    }

    case '/set_canvas_view': {
      if (!isUiCanvasViewMode(params.mode)) {
        return { error: 'mode must be one of fit_all, reset, zoom' }
      }
      let zoom: number | undefined
      if (params.mode === 'zoom') {
        zoom = Number(params.zoom)
        if (!Number.isFinite(zoom) || zoom < UI_CANVAS_MIN_ZOOM || zoom > UI_CANVAS_MAX_ZOOM) {
          return { error: `zoom must be a number between ${UI_CANVAS_MIN_ZOOM} and ${UI_CANVAS_MAX_ZOOM}` }
        }
      }
      if (params.mode === 'fit_all' && readCanvasPanels().length === 0) {
        return { error: 'The canvas is empty' }
      }
      return sendUiCommand({ kind: 'set_canvas_view', mode: params.mode, zoom })
    }

    case '/open_artifact': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!params.artifact_id) return { error: 'artifact_id is required' }
      const taskId = String(params.task_id)
      if (!db.getTask(taskId)) return { error: 'Task not found' }

      const artifactId = String(params.artifact_id)
      // A tab that names nothing shows an empty panel, so the artifact has to
      // exist before the window is told to open it.
      const known = await listRegisteredTaskArtifacts(db.getWorkspaceDir(taskId), taskId)
      if (!known.some((artifact) => artifact.artifactId === artifactId)) {
        return {
          error: 'Artifact not found for that task',
          artifacts: known.map((artifact) => ({ artifact_id: artifact.artifactId, title: artifact.title }))
        }
      }
      return sendUiCommand({ kind: 'open_artifact', taskId, artifactId })
    }

    // ── Acting on a running agent ─────────────────────────────

    case '/send_message': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!params.text || !String(params.text).trim()) return { error: 'text is required' }
      if (!agentController) return { error: 'Agent controller not available' }
      const taskId = String(params.task_id)
      const target = db.getTask(taskId)
      if (!target) return { error: 'Task not found' }

      // Waking a stopped agent needs an agent to wake. Without one the send
      // fails deep inside with "Session not found:", which names neither the
      // cause nor the cure.
      if (!target.agent_id && !agentController.findSessionByTaskId(taskId)) {
        return {
          error: 'That task has no agent assigned, so there is nobody to send to. Assign one with update_task, or use start_task to triage it.',
          reason: 'no_agent'
        }
      }

      // The message is attributed to the user, because that is who spoke it.
      // A transcript that credited the agent would misreport who asked.
      const result = await agentController.sendByTaskId(taskId, String(params.text))
      return { success: true, task_id: taskId, session_id: result.sessionId ?? result.newSessionId ?? null }
    }

    case '/respond_to_checkpoint': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (params.approved === undefined) return { error: 'approved is required' }
      if (!agentController) return { error: 'Agent controller not available' }
      const taskId = String(params.task_id)

      // Answer only a checkpoint that is really waiting, on the task named.
      // Without this a mis-heard word could answer an unrelated session, or a
      // session that has already moved on.
      const found = agentController.findSessionByTaskId(taskId)
      if (!found) return { error: 'No agent session for that task' }
      const live = agentController.getSessionStatus(found.sessionId)
      if (live?.status !== 'waiting_approval') {
        return { error: 'That task is not waiting for an answer' }
      }

      const approved = params.approved === true
      await agentController.respondToPermission(
        found.sessionId,
        approved,
        params.message ? String(params.message) : undefined
      )
      notifyRenderer?.('task:checkpointAnswered', { taskId, approved })
      return { success: true, task_id: taskId, approved }
    }

    case '/stop_task': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!agentController) return { error: 'Agent controller not available' }
      const taskId = String(params.task_id)
      const running = agentController.getActiveSessionsForTask(taskId)
      if (running.length === 0) return { success: false, task_id: taskId, reason: 'nothing_running' }
      const result = await agentController.stopByTaskId(taskId)
      return { success: true, task_id: taskId, session_id: result.sessionId }
    }

    case '/start_task': {
      if (!params.task_id) return { error: 'task_id is required' }
      if (!agentController) return { error: 'Agent controller not available' }

      const result = await agentController.startTask(String(params.task_id), {
        preferSubtasks: params.prefer_subtasks !== false,
        allowTriage: params.allow_triage !== false
      })

      const startedTask = result.startedTaskId ? db.getTask(result.startedTaskId) : null
      return {
        success: result.action !== 'no_action',
        ...result,
        task: startedTask
      }
    }

    case '/create_subtask': {
      if (!params.parent_task_id) return { error: 'parent_task_id is required' }
      if (!params.title) return { error: 'title is required' }

      // Verify parent task exists
      const parentTask = rawDb.prepare('SELECT id, repos, priority, auto_complete_without_review FROM tasks WHERE id = ?').get(params.parent_task_id) as Record<string, unknown> | undefined
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
        INSERT INTO tasks (id, title, description, type, priority, status, assignee, due_date, labels, attachments, repos, output_fields, source, agent_id, skill_ids, parent_task_id, sort_order, auto_complete_without_review, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'not_started', '', NULL, ?, '[]', ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?)
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
        // A child of a parent told to finish without review must not stop for
        // one either, or an unattended chain parks in review at the first step.
        // auto_start_agent is deliberately NOT inherited: children are started
        // through their parent, one at a time, in sort_order.
        params.auto_complete_without_review === undefined
          ? (parentTask.auto_complete_without_review ? 1 : 0)
          : (params.auto_complete_without_review === true ? 1 : 0),
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

      // A coordinator that creates children and then stops leaves them for
      // the automation loop. Poke it now so the first child starts at once.
      triggerTaskAutomation()

      return { success: true, task: parsedSubtask }
    }

    case '/wait_for_subtasks': {
      if (!params.parent_task_id) return { error: 'parent_task_id is required' }

      const timeoutMs = typeof params.timeout_ms === 'number' ? Math.max(1_000, params.timeout_ms) : 300_000
      const pollMs = 2_000
      const returnWhen = params.return_when === 'any_terminal' ? 'any_terminal' : 'all_terminal'
      const terminalStatuses = Array.isArray(params.terminal_statuses) && params.terminal_statuses.length > 0
        ? (params.terminal_statuses as string[])
        : [TaskStatus.ReadyForReview, TaskStatus.Completed]
      const targetIds = Array.isArray(params.subtask_ids) && params.subtask_ids.length > 0
        ? new Set((params.subtask_ids as string[]).map(String))
        : null

      const readSubtasks = () => {
        const subtasks = rawDb.prepare(
          'SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY sort_order ASC, created_at ASC'
        ).all(params.parent_task_id) as Record<string, unknown>[]
        subtasks.forEach(parseTask)
        return targetIds ? subtasks.filter((task) => targetIds.has(String(task.id))) : subtasks
      }

      const startedAt = Date.now()
      while (Date.now() - startedAt < timeoutMs) {
        const subtasks = readSubtasks()
        const matches = subtasks.filter((task) => terminalStatuses.includes(String(task.status)))

        if (subtasks.length > 0) {
          const done = returnWhen === 'any_terminal'
            ? matches.length > 0
            : matches.length === subtasks.length

          if (done) {
            return {
              success: true,
              timed_out: false,
              return_when: returnWhen,
              terminal_statuses: terminalStatuses,
              subtasks
            }
          }
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }

      return {
        success: false,
        timed_out: true,
        return_when: returnWhen,
        terminal_statuses: terminalStatuses,
        subtasks: readSubtasks()
      }
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

    // ── Browser-panel tools (panel-scoped broker; see panel-browser-broker.ts) ──
    case '/browser_list_panels': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      return { panels: panelBrowserBroker.listPanels(taskId) }
    }

    case '/browser_navigate': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      if (typeof params.url !== 'string' || !params.url.trim()) return { error: 'url is required' }
      return panelBrowserBroker.navigate(taskId, params.url, str(params.panel_id))
    }

    case '/browser_snapshot': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      return panelBrowserBroker.snapshot(taskId, str(params.panel_id))
    }

    case '/browser_click': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      if (typeof params.target !== 'string' || !params.target) return { error: 'target (@ref or CSS selector) is required' }
      return panelBrowserBroker.click(taskId, params.target, str(params.panel_id))
    }

    case '/browser_type': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      if (typeof params.target !== 'string' || !params.target) return { error: 'target (@ref or CSS selector) is required' }
      if (typeof params.text !== 'string') return { error: 'text is required' }
      return panelBrowserBroker.type(taskId, params.target, params.text, params.submit === true, str(params.panel_id))
    }

    case '/browser_press_key': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      if (typeof params.key !== 'string' || !params.key) return { error: 'key is required' }
      return panelBrowserBroker.pressKey(taskId, params.key, str(params.panel_id))
    }

    case '/browser_scroll': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      const direction = typeof params.direction === 'string' ? params.direction : undefined
      const amount = typeof params.amount === 'number' ? params.amount : undefined
      const target = typeof params.target === 'string' ? params.target : undefined
      return panelBrowserBroker.scroll(taskId, direction, amount, target, str(params.panel_id))
    }

    case '/browser_get': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      const what = typeof params.what === 'string' ? params.what : ''
      if (what !== 'url' && what !== 'title' && what !== 'text') return { error: 'what must be url | title | text' }
      return panelBrowserBroker.get(taskId, what, str(params.panel_id))
    }

    case '/browser_wait': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      const mode = params.mode
      if (mode !== 'selector' && mode !== 'text' && mode !== 'url') return { error: 'mode must be selector | text | url' }
      if (typeof params.value !== 'string' || !params.value) return { error: 'value is required' }
      return panelBrowserBroker.wait(
        taskId,
        mode,
        params.value,
        typeof params.timeout_ms === 'number' ? params.timeout_ms : undefined,
        str(params.panel_id)
      )
    }

    case '/browser_screenshot': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      return panelBrowserBroker.screenshot(taskId, str(params.panel_id))
    }

    case '/browser_back':
    case '/browser_forward':
    case '/browser_reload': {
      const taskId = typeof params.task_id === 'string' ? params.task_id : ''
      if (!taskId || !db.getTask(taskId)) return { error: 'Task not found' }
      const panelId = str(params.panel_id)
      if (route === '/browser_back') return panelBrowserBroker.back(taskId, panelId)
      if (route === '/browser_forward') return panelBrowserBroker.forward(taskId, panelId)
      return panelBrowserBroker.reload(taskId, panelId, params.hard === true)
    }

    default:
      return { error: 'Unknown route' }
  }
}

function safeParseArray(raw: string | null | undefined): unknown[] {
  const parsed = JSON.parse((raw as string) || '[]')
  return Array.isArray(parsed) ? parsed : (parsed != null && parsed !== '' ? [parsed] : [])
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function parseTask(task: Record<string, unknown>) {
  if (!task) return task
  task.labels = safeParseArray(task.labels as string)
  task.skill_ids = safeParseArray(task.skill_ids as string)
  task.attachments = safeParseArray(task.attachments as string)
  task.output_fields = safeParseArray(task.output_fields as string)
  task.repos = safeParseArray(task.repos as string)
  task.feedback_rating = task.feedback_rating ?? null
  task.feedback_comment = task.feedback_comment ?? null
  return task
}
