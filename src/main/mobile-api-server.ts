/**
 * Mobile API server — HTTP + WebSocket for controlling 20x from a mobile device.
 * Runs inside the Electron main process, shares DatabaseManager and AgentManager.
 * Serves the mobile SPA and provides REST + WebSocket endpoints.
 *
 * See docs/mobile-api-spec.md for the full API specification.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'http'
import { join } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import { WebSocketServer, WebSocket } from 'ws'
import type { DatabaseManager } from './database'
import type { AgentManager } from './agent-manager'

// ── State ────────────────────────────────────────────────────
let server: HttpServer | null = null
let wss: WebSocketServer | null = null
let dbRef: DatabaseManager | null = null
let agentRef: AgentManager | null = null
let authToken: string | null = null

const wsClients = new Set<WebSocket>()

// ── Public API ───────────────────────────────────────────────

export function startMobileApiServer(
  db: DatabaseManager,
  agentManager: AgentManager,
  port = 20620
): Promise<number> {
  if (server) return Promise.resolve(port)

  dbRef = db
  agentRef = agentManager

  // Read auth token from settings (optional)
  authToken = db.getSetting('mobile_auth_token') ?? null

  return new Promise((resolve, reject) => {
    server = createServer(handleHttpRequest)

    // WebSocket upgrade
    wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      // Auth check for WS
      if (authToken) {
        const url = new URL(req.url || '/', `http://localhost`)
        const token = url.searchParams.get('token')
        if (token !== authToken) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
      }

      if (req.url?.startsWith('/ws')) {
        wss!.handleUpgrade(req, socket, head, (ws) => {
          wsClients.add(ws)
          console.log(`[MobileAPI] WebSocket client connected (total: ${wsClients.size})`)

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
  // CORS headers for development (Vite dev server on different port)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Auth check
  if (authToken) {
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${authToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
  }

  const url = new URL(req.url || '/', `http://localhost`)
  const pathname = url.pathname

  // API routes
  if (pathname.startsWith('/api/')) {
    handleApiRoute(req, res, pathname, url)
    return
  }

  // Static file serving for mobile SPA
  serveMobileSPA(res, pathname)
}

// ── API router ───────────────────────────────────────────────

function handleApiRoute(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): void {
  res.setHeader('Content-Type', 'application/json')

  // Collect body for POST requests
  if (req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let params: Record<string, unknown> = {}
      if (body) {
        try { params = JSON.parse(body) } catch { /* ignore */ }
      }

      try {
        const result = await routePost(pathname, params)
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
      const result = routeGet(pathname, url)
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

function routeGet(pathname: string, url: URL): unknown {
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

    tasks.sort((a, b) => {
      const va = (a as Record<string, unknown>)[sort]
      const vb = (b as Record<string, unknown>)[sort]
      if (va == null && vb == null) return 0
      if (va == null) return dir
      if (vb == null) return -dir
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
    return db.getAgents()
  }

  // GET /api/agents/:id
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/)
  if (agentMatch) {
    const agent = db.getAgent(agentMatch[1])
    if (!agent) throw Object.assign(new Error('Agent not found'), { status: 404 })
    return agent
  }

  // GET /api/sessions
  if (pathname === '/api/sessions') {
    return getActiveSessions()
  }

  throw Object.assign(new Error('Not found'), { status: 404 })
}

// ── POST routes ──────────────────────────────────────────────

async function routePost(pathname: string, params: Record<string, unknown>): Promise<unknown> {
  const agent = agentRef!
  const db = dbRef!

  // POST /api/tasks/:id — update task
  const taskUpdateMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/)
  if (taskUpdateMatch) {
    const taskId = taskUpdateMatch[1]
    const existing = db.getTask(taskId)
    if (!existing) throw Object.assign(new Error('Task not found'), { status: 404 })
    const updated = db.updateTask(taskId, params as Parameters<DatabaseManager['updateTask']>[1])
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
    const { message, taskId, agentId: aid } = params as { message: string; taskId?: string; agentId?: string }
    if (!message) throw Object.assign(new Error('message is required'), { status: 400 })
    const result = await agent.sendMessage(sessionId, message, taskId, aid)
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

  throw Object.assign(new Error('Not found'), { status: 404 })
}

// ── Helpers ──────────────────────────────────────────────────

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

function serveMobileSPA(res: ServerResponse, pathname: string): void {
  // Resolve static file from out/mobile/
  const mobileDir = join(__dirname, '../mobile')
  let filePath = join(mobileDir, pathname === '/' ? 'index.html' : pathname)

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
