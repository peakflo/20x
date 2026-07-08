/**
 * Mobile API server — HTTP + WebSocket for controlling 20x from a mobile device.
 * Runs inside the Electron main process, shares DatabaseManager and AgentManager.
 * Serves the mobile SPA and provides REST + WebSocket endpoints.
 *
 * See docs/mobile-api-spec.md for the full API specification.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'http'
import { join, sep } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID, createHash, randomInt } from 'crypto'
import type { DatabaseManager } from './database'
import type { AgentManager } from './agent-manager'
import type { GitHubManager } from './github-manager'
import type { GitLabManager } from './gitlab-manager'
import type { SyncManager } from './sync-manager'
import type { PluginRegistry } from './plugins/registry'

// ── State ────────────────────────────────────────────────────
let server: HttpServer | null = null
let wss: WebSocketServer | null = null
let dbRef: DatabaseManager | null = null
let agentRef: AgentManager | null = null
let githubRef: GitHubManager | null = null
let gitlabRef: GitLabManager | null = null
let syncManagerRef: SyncManager | null = null
let pluginRegistryRef: PluginRegistry | null = null
let notifyDesktop: ((channel: string, data: unknown) => void) | null = null

const wsClients = new Set<WebSocket>()

const PIN_EXPIRY_SECONDS = 60
const PIN_MAX_ATTEMPTS = 3

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function validateSession(provided: string | null | undefined): boolean {
  if (!provided || !dbRef) return false
  const hash = hashToken(provided)
  const session = dbRef.getMobileSessionByTokenHash(hash)
  if (!session) return false
  dbRef.touchMobileSession(hash)
  return true
}

// ── Public API ───────────────────────────────────────────────

export function startMobileApiServer(
  db: DatabaseManager,
  agentManager: AgentManager,
  githubManager: GitHubManager,
  port = 20620,
  syncManager?: SyncManager | null,
  pluginRegistry?: PluginRegistry | null,
  gitlabManager?: GitLabManager | null
): Promise<number> {
  if (server) return Promise.resolve(port)

  dbRef = db
  agentRef = agentManager
  githubRef = githubManager
  gitlabRef = gitlabManager ?? null
  syncManagerRef = syncManager ?? null
  pluginRegistryRef = pluginRegistry ?? null

  return new Promise((resolve, reject) => {
    server = createServer(handleHttpRequest)

    // WebSocket upgrade
    wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://localhost`)
      const token = url.searchParams.get('token')
      if (!validateSession(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      if (req.url?.startsWith('/ws')) {
        wss!.handleUpgrade(req, socket, head, (ws) => {
          wsClients.add(ws)
          console.log(`[MobileAPI] WebSocket client connected (total: ${wsClients.size})`)

          ws.on('message', (data) => {
            try {
              const msg = JSON.parse(String(data))
              if (msg.type === 'ping') {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'pong' }))
                }
              }
            } catch {
              // ignore malformed messages
            }
          })

          ws.on('close', () => {
            wsClients.delete(ws)
            console.log(`[MobileAPI] WebSocket client disconnected (total: ${wsClients.size})`)
          })

          ws.on('error', () => {
            wsClients.delete(ws)
          })
        })
      } else {
        socket.destroy()
      }
    })

    server.listen(port, '0.0.0.0', () => {
      console.log(`[MobileAPI] Started on port ${port} — http://0.0.0.0:${port}`)
      resolve(port)
    })

    server.on('error', reject)
  })
}

/**
 * Set a callback to notify the desktop (Electron renderer) of events
 * originating from the mobile API (e.g. task created/updated).
 */
export function setMobileApiNotifier(fn: (channel: string, data: unknown) => void): void {
  notifyDesktop = fn
}

export function stopMobileApiServer(): void {
  for (const ws of wsClients) {
    ws.close()
  }
  wsClients.clear()
  wss?.close()
  wss = null
  server?.close()
  server = null
}

/**
 * Called by AgentManager (via external listener) whenever it sends an event.
 * Broadcasts to all connected WebSocket clients.
 */
export function broadcastToMobileClients(channel: string, data: unknown): void {
  if (wsClients.size === 0) return

  const message = JSON.stringify({ type: channel, payload: data })
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message)
    }
  }
}

// ── MIME types for static file serving ───────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

// ── HTTP request handler ─────────────────────────────────────

function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  // CORS — only allow localhost origins (for Vite dev server).
  // The mobile SPA is served from the same origin and doesn't need CORS.
  const origin = req.headers.origin
  if (origin) {
    try {
      const originUrl = new URL(origin)
      if (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1') {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      }
    } catch {
      // invalid origin header — ignore
    }
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url || '/', `http://localhost`)
  const pathname = url.pathname

  // Pairing endpoints — no session required
  if (pathname === '/api/auth/pair/initiate' || pathname === '/api/auth/pair/verify') {
    void handleApiRoute(req, res, pathname, url)
    return
  }

  // All other API routes — require valid session
  if (pathname.startsWith('/api/')) {
    const authHeader = req.headers.authorization
    const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!validateSession(provided)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    void handleApiRoute(req, res, pathname, url)
    return
  }

  // Static file serving for mobile SPA — no auth needed
  // (the SPA reads the token from the URL hash fragment and sends it with API calls)
  serveMobileSPA(res, pathname)
}

// ── API router ───────────────────────────────────────────────

async function handleApiRoute(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
  res.setHeader('Content-Type', 'application/json')

  // Collect body for POST requests
  if (req.method === 'POST') {
    const MAX_BODY = 1_048_576 // 1 MB
    let body = ''
    let overflow = false
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY) { overflow = true; req.destroy() }
    })
    req.on('end', async () => {
      if (overflow) {
        res.writeHead(413)
        res.end(JSON.stringify({ error: 'Request body too large' }))
        return
      }
      let params: Record<string, unknown> = {}
      if (body) {
        try { params = JSON.parse(body) } catch { /* ignore */ }
      }

      try {
        const result = await routePost(pathname, params, req)
        res.writeHead(200)
        res.end(JSON.stringify(result))
      } catch (err: unknown) {
        const status = (err as { status?: number }).status || 500
        const message = err instanceof Error ? err.message : String(err)
        res.writeHead(status)
        res.end(JSON.stringify({ error: message }))
      }
    })
    return
  }

  // GET requests
  if (req.method === 'GET') {
    try {
      const result = await routeGet(pathname, url)
      res.writeHead(200)
      res.end(JSON.stringify(result))
    } catch (err: unknown) {
      const status = (err as { status?: number }).status || 500
      const message = err instanceof Error ? err.message : String(err)
      res.writeHead(status)
      res.end(JSON.stringify({ error: message }))
    }
    return
  }

  res.writeHead(405)
  res.end(JSON.stringify({ error: 'Method not allowed' }))
}

// ── GET routes ───────────────────────────────────────────────

async function routeGet(pathname: string, url: URL): Promise<unknown> {
  const db = dbRef!

  // GET /api/tasks
  if (pathname === '/api/tasks') {
    let tasks = db.getTasks()

    const status = url.searchParams.get('status')
    if (status) tasks = tasks.filter(t => t.status === status)

    const priority = url.searchParams.get('priority')
    if (priority) tasks = tasks.filter(t => t.priority === priority)

    const source = url.searchParams.get('source')
    if (source) tasks = tasks.filter(t => t.source === source)

    const search = url.searchParams.get('search')
    if (search) {
      const q = search.toLowerCase()
      tasks = tasks.filter(t =>
        t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
      )
    }

    const sort = url.searchParams.get('sort') || 'created_at'
    const order = url.searchParams.get('order') || 'desc'
    const dir = order === 'asc' ? 1 : -1

    const PRIORITY_ORDER: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 }
    const STATUS_ORDER: Record<string, number> = { agent_working: 5, agent_learning: 4, triaging: 3, ready_for_review: 2, not_started: 1, completed: 0 }

    tasks.sort((a, b) => {
      const va = (a as unknown as Record<string, unknown>)[sort]
      const vb = (b as unknown as Record<string, unknown>)[sort]
      if (va == null && vb == null) return 0
      if (va == null) return dir
      if (vb == null) return -dir
      // Use semantic ordering for priority and status instead of alphabetical
      if (sort === 'priority') {
        const pa = PRIORITY_ORDER[va as string] ?? 0
        const pb = PRIORITY_ORDER[vb as string] ?? 0
        return (pa - pb) * dir
      }
      if (sort === 'status') {
        const sa = STATUS_ORDER[va as string] ?? 0
        const sb = STATUS_ORDER[vb as string] ?? 0
        return (sa - sb) * dir
      }
      if (va < vb) return -dir
      if (va > vb) return dir
      return 0
    })

    return tasks
  }

  // GET /api/tasks/:id
  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/)
  if (taskMatch) {
    const task = db.getTask(taskMatch[1])
    if (!task) throw Object.assign(new Error('Task not found'), { status: 404 })
    return task
  }

  // GET /api/agents
  if (pathname === '/api/agents') {
    return db.getAgents().map(stripSensitiveAgentFields)
  }

  // GET /api/agents/:id
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/)
  if (agentMatch) {
    const agent = db.getAgent(agentMatch[1])
    if (!agent) throw Object.assign(new Error('Agent not found'), { status: 404 })
    return stripSensitiveAgentFields(agent)
  }

  // GET /api/skills
  if (pathname === '/api/skills') {
    return db.getSkills()
  }

  // GET /api/sessions
  if (pathname === '/api/sessions') {
    return getActiveSessions()
  }

  // GET /api/auth/sessions — connected devices list
  if (pathname === '/api/auth/sessions') {
    return db.getMobileSessions()
  }

  // GET /api/task-sources — list all configured task sources
  if (pathname === '/api/task-sources') {
    return db.getTaskSources()
  }

  // GET /api/plugins — list available plugins
  if (pathname === '/api/plugins') {
    if (!pluginRegistryRef) return []
    return pluginRegistryRef.list()
  }

  // GET /api/plugins/:id/schema — get config schema for a plugin
  const pluginSchemaMatch = pathname.match(/^\/api\/plugins\/([^/]+)\/schema$/)
  if (pluginSchemaMatch) {
    if (!pluginRegistryRef) throw Object.assign(new Error('Plugin registry not available'), { status: 503 })
    const plugin = pluginRegistryRef.get(pluginSchemaMatch[1])
    if (!plugin) throw Object.assign(new Error('Plugin not found'), { status: 404 })
    return plugin.getConfigSchema()
  }

  // GET /api/plugins/:id/documentation — get setup documentation for a plugin
  const pluginDocMatch = pathname.match(/^\/api\/plugins\/([^/]+)\/documentation$/)
  if (pluginDocMatch) {
    if (!pluginRegistryRef) throw Object.assign(new Error('Plugin registry not available'), { status: 503 })
    const plugin = pluginRegistryRef.get(pluginDocMatch[1])
    if (!plugin) throw Object.assign(new Error('Plugin not found'), { status: 404 })
    return { documentation: plugin.getSetupDocumentation?.() ?? null }
  }

  // GET /api/github/org — returns the configured github org
  if (pathname === '/api/github/org') {
    const org = db.getSetting('github_org') || ''
    return { org }
  }

  // GET /api/git/provider — returns the configured git provider
  if (pathname === '/api/git/provider') {
    const provider = db.getSetting('git_provider') || 'github'
    return { provider }
  }

  // GET /api/github/orgs — returns available orgs + personal accounts
  // Fetches from ALL authenticated providers (GitHub and/or GitLab)
  if (pathname === '/api/github/orgs') {
    const owners: Array<{ value: string; label: string; provider: string }> = []

    // Try GitHub
    if (githubRef) {
      try {
        const [status, orgs] = await Promise.all([
          githubRef.checkGhCli(),
          githubRef.fetchUserOrgs()
        ])
        if (status.authenticated) {
          if (status.username) {
            owners.push({ value: status.username, label: `${status.username} (GitHub personal)`, provider: 'github' })
          }
          for (const orgName of orgs) {
            owners.push({ value: orgName, label: `${orgName} (GitHub)`, provider: 'github' })
          }
        }
      } catch { /* GitHub not available — skip */ }
    }

    // Try GitLab
    if (gitlabRef) {
      try {
        const [status, orgs] = await Promise.all([
          gitlabRef.checkGlabCli(),
          gitlabRef.fetchUserOrgs()
        ])
        if (status.authenticated) {
          if (status.username) {
            owners.push({ value: status.username, label: `${status.username} (GitLab personal)`, provider: 'gitlab' })
          }
          for (const orgName of orgs) {
            owners.push({ value: orgName, label: `${orgName} (GitLab)`, provider: 'gitlab' })
          }
        }
      } catch { /* GitLab not available — skip */ }
    }

    if (owners.length === 0) {
      throw Object.assign(new Error('No git provider authenticated'), { status: 500 })
    }

    return owners
  }

  throw Object.assign(new Error('Not found'), { status: 404 })
}

// ── POST routes ──────────────────────────────────────────────

async function routePost(pathname: string, params: Record<string, unknown>, req?: IncomingMessage): Promise<unknown> {
  const agent = agentRef!
  const db = dbRef!

  // POST /api/auth/pair/initiate — phone sends init code, server generates PIN
  if (pathname === '/api/auth/pair/initiate') {
    const { code } = params as { code?: string }
    if (!code) throw Object.assign(new Error('code is required'), { status: 400 })

    const now = Math.floor(Date.now() / 1000)
    // Validate init code exists and not expired
    const validCode = db.getSetting(`mobile_init_code_${code}`)
    const validUntil = db.getSetting(`mobile_init_code_${code}_exp`)
    if (!validCode || !validUntil || now > parseInt(validUntil)) {
      throw Object.assign(new Error('Invalid or expired QR code. Please scan a new QR code.'), { status: 401 })
    }
    // Delete init code — single use
    db.deleteSetting(`mobile_init_code_${code}`)
    db.deleteSetting(`mobile_init_code_${code}_exp`)

    // Generate PIN and pair code ID
    const pin = String(randomInt(100000, 1000000))
    const pairCodeId = randomUUID()
    db.createMobilePairCode(pairCodeId, pin, now + PIN_EXPIRY_SECONDS)

    // Push PIN to desktop
    if (notifyDesktop) {
      notifyDesktop('mobile:pairing-initiated', { pin, pairCodeId, expiresAt: now + PIN_EXPIRY_SECONDS })
    }

    return { pairCodeId, expiresIn: PIN_EXPIRY_SECONDS }
  }

  // POST /api/auth/pair/verify — phone submits PIN
  if (pathname === '/api/auth/pair/verify') {
    const { pairCodeId, pin } = params as { pairCodeId?: string; pin?: string }
    if (!pairCodeId || !pin) throw Object.assign(new Error('pairCodeId and pin are required'), { status: 400 })

    const now = Math.floor(Date.now() / 1000)
    const record = db.getMobilePairCode(pairCodeId)

    if (!record) throw Object.assign(new Error('Invalid pairing session'), { status: 401 })
    if (now > record.expires_at) {
      db.deleteMobilePairCode(pairCodeId)
      throw Object.assign(new Error('PIN expired. Please scan the QR code again.'), { status: 401 })
    }

    const attempts = db.incrementPairCodeAttempts(pairCodeId)
    if (attempts > PIN_MAX_ATTEMPTS) {
      db.deleteMobilePairCode(pairCodeId)
      throw Object.assign(new Error('Too many incorrect attempts. Please scan the QR code again.'), { status: 401 })
    }

    if (record.pin !== pin.trim()) {
      const remaining = PIN_MAX_ATTEMPTS - attempts
      throw Object.assign(new Error(`Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`), { status: 401 })
    }

    // PIN correct — issue session token
    db.deleteMobilePairCode(pairCodeId)
    const sessionToken = randomUUID()
    const tokenHash = hashToken(sessionToken)
    const sessionId = randomUUID()
    const userAgent = req?.headers['user-agent'] || 'Unknown device'
    const deviceName = parseDeviceName(userAgent)
    db.createMobileSession(sessionId, tokenHash, deviceName)

    // Notify desktop of new connection
    if (notifyDesktop) {
      notifyDesktop('mobile:device-connected', { sessionId, deviceName })
    }

    return { sessionToken, sessionId, deviceName }
  }

  // POST /api/plugins/:id/resolve-options — resolve dynamic options for a plugin config field
  const pluginResolveMatch = pathname.match(/^\/api\/plugins\/([^/]+)\/resolve-options$/)
  if (pluginResolveMatch) {
    if (!pluginRegistryRef) throw Object.assign(new Error('Plugin registry not available'), { status: 503 })
    const pluginId = pluginResolveMatch[1]
    const plugin = pluginRegistryRef.get(pluginId)
    if (!plugin) throw Object.assign(new Error('Plugin not found'), { status: 404 })

    const { resolverKey, config } = params as { resolverKey?: string; config?: Record<string, unknown> }
    if (!resolverKey) throw Object.assign(new Error('resolverKey is required'), { status: 400 })

    // YouTrack and other non-MCP plugins don't use toolCaller, but the type requires it
    const ctx = { db } as Parameters<typeof plugin.resolveOptions>[2]
    const options = await plugin.resolveOptions(resolverKey, config || {}, ctx)
    return options
  }

  // POST /api/task-sources — create a new task source
  if (pathname === '/api/task-sources') {
    const { name, plugin_id, config, mcp_server_id } = params as {
      name?: string; plugin_id?: string; config?: Record<string, unknown>; mcp_server_id?: string | null
    }
    if (!name || !plugin_id) throw Object.assign(new Error('name and plugin_id are required'), { status: 400 })
    const source = db.createTaskSource({ name, plugin_id, config: config || {}, mcp_server_id: mcp_server_id || null })
    return source
  }

  // POST /api/task-sources/sync-all — sync all enabled task sources (must be before :id routes)
  if (pathname === '/api/task-sources/sync-all') {
    if (!syncManagerRef) throw Object.assign(new Error('Sync manager not available'), { status: 503 })
    const sources = db.getTaskSources().filter((s: { enabled: boolean }) => s.enabled)
    const results = await Promise.allSettled(
      sources.map((s: { id: string }) => syncManagerRef!.importTasks(s.id))
    )
    return results.map((r) =>
      r.status === 'fulfilled' ? r.value : { error: String((r as PromiseRejectedResult).reason) }
    )
  }

  // POST /api/task-sources/:id/sync — sync a single task source
  const sourceSyncMatch = pathname.match(/^\/api\/task-sources\/([^/]+)\/sync$/)
  if (sourceSyncMatch) {
    if (!syncManagerRef) throw Object.assign(new Error('Sync manager not available'), { status: 503 })
    const result = await syncManagerRef.importTasks(sourceSyncMatch[1])
    return result
  }

  // POST /api/task-sources/:id — update a task source
  const sourceUpdateMatch = pathname.match(/^\/api\/task-sources\/([^/]+)$/)
  if (sourceUpdateMatch) {
    const sourceId = sourceUpdateMatch[1]
    const source = db.getTaskSource(sourceId)
    if (!source) throw Object.assign(new Error('Task source not found'), { status: 404 })
    const updated = db.updateTaskSource(sourceId, params as Parameters<DatabaseManager['updateTaskSource']>[1])
    return updated
  }

  // POST /api/tasks/reorder-subtasks — reorder subtasks under a parent
  if (pathname === '/api/tasks/reorder-subtasks') {
    const { parentId, orderedIds } = params as { parentId?: string; orderedIds?: string[] }
    if (!parentId || !Array.isArray(orderedIds)) {
      throw Object.assign(new Error('parentId and orderedIds are required'), { status: 400 })
    }
    db.reorderSubtasks(parentId, orderedIds)
    broadcastToMobileClients('task:subtasks-reordered', { parentId, orderedIds })
    if (notifyDesktop) notifyDesktop('task:subtasks-reordered', { parentId, orderedIds })
    return { success: true }
  }

  // POST /api/tasks — create task (must be checked before the :id update route)
  if (pathname === '/api/tasks') {
    const { title } = params as { title?: string }
    if (!title) throw Object.assign(new Error('title is required'), { status: 400 })
    const task = db.createTask(params as unknown as Parameters<DatabaseManager['createTask']>[0])
    if (!task) throw Object.assign(new Error('Failed to create task'), { status: 500 })
    broadcastToMobileClients('task:created', { task })
    if (notifyDesktop) notifyDesktop('task:created', { task })
    return task
  }

  // POST /api/tasks/:id — update task
  const taskUpdateMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/)
  if (taskUpdateMatch) {
    const taskId = taskUpdateMatch[1]
    const existing = db.getTask(taskId)
    if (!existing) throw Object.assign(new Error('Task not found'), { status: 404 })
    const updated = db.updateTask(taskId, params as Parameters<DatabaseManager['updateTask']>[1])
    if (updated) {
      broadcastToMobileClients('task:updated', { taskId, updates: updated })
      if (notifyDesktop) notifyDesktop('task:updated', { taskId, updates: updated })
    }
    return updated
  }

  // POST /api/sessions/start
  if (pathname === '/api/sessions/start') {
    const { agentId, taskId, skipInitialPrompt } = params as { agentId: string; taskId: string; skipInitialPrompt?: boolean }
    if (!agentId || !taskId) throw Object.assign(new Error('agentId and taskId are required'), { status: 400 })
    const sessionId = await agent.startSession(agentId, taskId, undefined, skipInitialPrompt as boolean | undefined)
    return { sessionId }
  }

  // POST /api/sessions/:sessionId/resume
  const resumeMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/)
  if (resumeMatch) {
    const sessionId = resumeMatch[1]
    const { agentId, taskId } = params as { agentId: string; taskId: string }
    if (!agentId || !taskId) throw Object.assign(new Error('agentId and taskId are required'), { status: 400 })
    const newSessionId = await agent.resumeSession(agentId, taskId, sessionId)
    return { sessionId: newSessionId }
  }

  // POST /api/sessions/:sessionId/send
  const sendMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/send$/)
  if (sendMatch) {
    const sessionId = sendMatch[1]
    const { message, taskId, agentId: aid, attachments } = params as {
      message: string
      taskId?: string
      agentId?: string
      attachments?: Array<{ id: string; filename: string; size: number; mime_type: string }>
    }
    if (!message) throw Object.assign(new Error('message is required'), { status: 400 })
    const result = await agent.sendMessage(sessionId, message, taskId, aid, attachments)
    return { success: true, ...result }
  }

  // POST /api/sessions/:sessionId/approve
  const approveMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/approve$/)
  if (approveMatch) {
    const sessionId = approveMatch[1]
    const { approved, message } = params as { approved: boolean; message?: string }
    if (typeof approved !== 'boolean') throw Object.assign(new Error('approved (boolean) is required'), { status: 400 })
    await agent.respondToPermission(sessionId, approved, message)
    return { success: true }
  }

  // POST /api/sessions/:sessionId/sync — replay messages from a running session
  const syncMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/sync$/)
  if (syncMatch) {
    const sessionId = syncMatch[1]
    const status = agent.getSessionStatus(sessionId)
    if (!status) throw Object.assign(new Error('Session not found or not running'), { status: 404 })
    await agent.replaySessionMessages(sessionId)
    return { success: true, status: status.status }
  }

  // POST /api/sessions/:sessionId/abort
  const abortMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/)
  if (abortMatch) {
    await agent.abortSession(abortMatch[1])
    return { success: true }
  }

  // POST /api/sessions/:sessionId/stop
  const stopMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/)
  if (stopMatch) {
    await agent.stopSession(stopMatch[1])
    return { success: true }
  }

  // POST /api/github/repos — fetch org repos
  // Accepts optional `provider` param ('github' | 'gitlab') to route to the right backend.
  // Falls back to the configured git_provider setting for backward compat.
  if (pathname === '/api/github/repos') {
    const { org, provider: reqProvider } = params as { org?: string; provider?: string }
    if (!org) throw Object.assign(new Error('org is required'), { status: 400 })

    const provider = reqProvider || db.getSetting('git_provider') || 'github'

    if (provider === 'gitlab') {
      if (!gitlabRef) throw Object.assign(new Error('GitLab not configured'), { status: 500 })
      const repos = await gitlabRef.fetchOrgRepos(org)
      return repos
    }

    if (!githubRef) throw Object.assign(new Error('GitHub not configured'), { status: 500 })
    const repos = await githubRef.fetchOrgRepos(org)
    return repos
  }

  // POST /api/github/org — set configured github org
  if (pathname === '/api/github/org') {
    const { org } = params as { org?: string }
    if (!org) throw Object.assign(new Error('org is required'), { status: 400 })
    db.setSetting('github_org', org)
    return { org }
  }

  throw Object.assign(new Error('Not found'), { status: 404 })
}

// ── Helpers ──────────────────────────────────────────────────

function parseDeviceName(userAgent: string): string {
  if (/iPhone/i.test(userAgent)) return 'iPhone'
  if (/iPad/i.test(userAgent)) return 'iPad'
  if (/Android/i.test(userAgent)) return 'Android'
  if (/Windows/i.test(userAgent)) return 'Windows Browser'
  if (/Mac/i.test(userAgent)) return 'Mac Browser'
  return 'Unknown device'
}

function getActiveSessions(): Array<{ sessionId: string; agentId: string; taskId: string; status: string }> {
  if (!dbRef) return []

  // Walk all tasks that have a session_id and check against AgentManager
  const tasks = dbRef.getTasks()
  const results: Array<{ sessionId: string; agentId: string; taskId: string; status: string }> = []

  for (const task of tasks) {
    if (!task.session_id || !task.agent_id) continue
    const sessionStatus = agentRef?.getSessionStatus(task.session_id)
    if (sessionStatus) {
      results.push({
        sessionId: task.session_id,
        agentId: sessionStatus.agentId,
        taskId: sessionStatus.taskId,
        status: sessionStatus.status
      })
    }
  }
  return results
}

/** Strip sensitive fields (api_keys, secret_ids) from agent config before sending over the network. */
function stripSensitiveAgentFields(agent: ReturnType<DatabaseManager['getAgent']>) {
  if (!agent) return agent
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { api_keys: _keys, secret_ids: _secrets, ...safeConfig } = (agent.config || {}) as Record<string, unknown>
  return { ...agent, config: safeConfig }
}

function serveMobileSPA(res: ServerResponse, pathname: string): void {
  // Resolve static file from out/mobile/
  const mobileDir = join(__dirname, '../mobile')
  const resolved = join(mobileDir, pathname === '/' ? 'index.html' : pathname)

  // Guard against path traversal — ensure resolved path stays inside mobileDir
  let filePath: string
  if (!resolved.startsWith(mobileDir + sep) && resolved !== join(mobileDir, 'index.html')) {
    filePath = join(mobileDir, 'index.html')
  } else {
    filePath = resolved
  }

  // If not found, serve index.html (SPA fallback)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(mobileDir, 'index.html')
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Mobile UI not built. Run: pnpm build:mobile')
    return
  }

  const ext = filePath.substring(filePath.lastIndexOf('.'))
  const mime = MIME[ext] || 'application/octet-stream'

  res.writeHead(200, { 'Content-Type': mime })
  res.end(readFileSync(filePath))
}
