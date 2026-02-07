import { EventEmitter } from 'events'
import { spawn, type ChildProcess } from 'child_process'
import type { BrowserWindow } from 'electron'
import type { DatabaseManager } from './database'

// Import OpenCode SDK dynamically
let OpenCodeSDK: typeof import('@opencode-ai/sdk') | null = null

interface AgentSession {
  id: string
  agentId: string
  taskId: string
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
  createdAt: Date
  ocClient?: ReturnType<typeof import('@opencode-ai/sdk').createOpencodeClient>
  ocSessionId?: string
}

export class AgentManager extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map()
  private serverProcess: ChildProcess | null = null
  private db: DatabaseManager
  private mainWindow: BrowserWindow | null = null

  constructor(db: DatabaseManager) {
    super()
    this.db = db
    this.loadSDK()
  }

  private async loadSDK(): Promise<void> {
    try {
      OpenCodeSDK = await import('@opencode-ai/sdk')
      console.log('[AgentManager] OpenCode SDK loaded successfully')
    } catch (error) {
      console.error('[AgentManager] Failed to load OpenCode SDK:', error)
    }
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  async startServer(): Promise<void> {
    if (this.serverProcess) {
      console.log('[AgentManager] Server already running')
      return
    }

    return new Promise((resolve, reject) => {
      console.log('[AgentManager] Starting OpenCode server...')

      this.serverProcess = spawn('opencode', ['serve'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
      })

      let isReady = false
      const timeout = setTimeout(() => {
        if (!isReady) {
          this.stopServer()
          reject(new Error('Server startup timeout'))
        }
      }, 30000)

      this.serverProcess.stdout?.on('data', (data) => {
        const output = data.toString()
        console.log('[OpenCode Server]', output)

        if (output.includes('ready') || output.includes('listening') || output.includes('http://')) {
          if (!isReady) {
            isReady = true
            clearTimeout(timeout)
            console.log('[AgentManager] Server ready')
            resolve()
          }
        }
      })

      this.serverProcess.stderr?.on('data', (data) => {
        console.error('[OpenCode Server Error]', data.toString())
      })

      this.serverProcess.on('error', (error) => {
        console.error('[AgentManager] Server process error:', error)
        if (!isReady) {
          clearTimeout(timeout)
          reject(error)
        }
        this.emit('serverError', error)
      })

      this.serverProcess.on('exit', (code) => {
        console.log(`[AgentManager] Server exited with code ${code}`)
        this.serverProcess = null
        this.emit('serverExit', code)

        // Notify all active sessions
        for (const session of this.sessions.values()) {
          this.sendToRenderer('agent:status', {
            sessionId: session.id,
            agentId: session.agentId,
            taskId: session.taskId,
            status: 'error'
          })
        }
      })
    })
  }

  stopServer(): void {
    if (this.serverProcess) {
      console.log('[AgentManager] Stopping OpenCode server...')
      this.serverProcess.kill('SIGTERM')
      this.serverProcess = null
    }
  }

  async startSession(agentId: string, taskId: string): Promise<string> {
    if (!OpenCodeSDK) {
      throw new Error('OpenCode SDK not loaded')
    }

    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    // Check if session already exists for this task
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.taskId === taskId && session.status !== 'error') {
        console.log(`[AgentManager] Session already exists for task ${taskId}: ${sessionId}`)
        return sessionId
      }
    }

    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    console.log(`[AgentManager] Starting session ${sessionId} for agent ${agentId} on task ${taskId}`)

    const ocClient = OpenCodeSDK.createOpencodeClient({
      baseUrl: agent.server_url
    })

    const session: AgentSession = {
      id: sessionId,
      agentId,
      taskId,
      status: 'working',
      createdAt: new Date(),
      ocClient
    }

    this.sessions.set(sessionId, session)

    try {
      // Create OpenCode session
      const result: any = await ocClient.session.create({
        body: {
          title: `Task ${taskId}`
        }
      })

      if (result.error) {
        const errorMsg = result.error.data?.message || result.error.name || 'Failed to create session'
        throw new Error(errorMsg)
      }

      if (result.data) {
        session.ocSessionId = result.data.id
        console.log(`[AgentManager] OpenCode session created: ${result.data.id}`)

        // Send initial task message
        const task = this.db.getTask(taskId)
        if (task && session.ocSessionId) {
          const promptResult: any = await ocClient.session.prompt({
            path: {
              id: session.ocSessionId
            },
            body: {
              parts: [
                {
                  type: 'text',
                  text: `Working on task: "${task.title}"\n\n${task.description || ''}`
                }
              ]
            }
          })

          if (promptResult.error) {
            console.error('[AgentManager] Failed to send initial message:', promptResult.error)
          } else {
            console.log('[AgentManager] Initial message sent successfully')
          }
        }

        // Start polling for events
        this.pollSessionEvents(sessionId)
      }

      // Send status update
      this.sendToRenderer('agent:status', {
        sessionId,
        agentId,
        taskId,
        status: 'working'
      })

      return sessionId
    } catch (error) {
      console.error(`[AgentManager] Failed to start session ${sessionId}:`, error)
      session.status = 'error'
      this.sessions.delete(sessionId)
      throw error
    }
  }

  private async pollSessionEvents(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.ocClient || !session.ocSessionId) return

    try {
      // Get global events from OpenCode
      const eventResult: any = await session.ocClient.global.event()
      
      if (eventResult.data && Array.isArray(eventResult.data)) {
        // Process events
        for (const event of eventResult.data) {
          this.sendToRenderer('agent:output', {
            sessionId,
            type: 'message',
            data: event
          })

          // Check for permission requests
          if (event.type === 'permission') {
            session.status = 'waiting_approval'
            this.sendToRenderer('agent:approval', {
              sessionId,
              action: event.action,
              description: event.description || event.action
            })
            this.sendToRenderer('agent:status', {
              sessionId,
              agentId: session.agentId,
              taskId: session.taskId,
              status: 'waiting_approval'
            })
          }
        }
      }
    } catch (error) {
      console.error(`[AgentManager] Error polling events for session ${sessionId}:`, error)
    }

    // Continue polling if session is still active
    if (this.sessions.has(sessionId) && session.status !== 'error') {
      setTimeout(() => this.pollSessionEvents(sessionId), 2000)
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      console.log(`[AgentManager] Session ${sessionId} not found`)
      return
    }

    console.log(`[AgentManager] Stopping session ${sessionId}`)

    // Try to delete the OpenCode session
    if (session.ocClient && session.ocSessionId) {
      try {
        await session.ocClient.session.delete({
          path: {
            id: session.ocSessionId
          }
        })
        console.log(`[AgentManager] OpenCode session ${session.ocSessionId} deleted`)
      } catch (error) {
        console.error(`[AgentManager] Error deleting OpenCode session:`, error)
      }
    }

    this.sessions.delete(sessionId)
    this.sendToRenderer('agent:status', {
      sessionId,
      agentId: session.agentId,
      taskId: session.taskId,
      status: 'idle'
    })
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    if (session.status === 'error') {
      throw new Error('Session is in error state')
    }

    if (!session.ocClient || !session.ocSessionId) {
      throw new Error('OpenCode session not initialized')
    }

    console.log(`[AgentManager] Sending message to session ${sessionId}:`, message)

    try {
      const result: any = await session.ocClient.session.prompt({
        path: {
          id: session.ocSessionId
        },
        body: {
          parts: [
            {
              type: 'text',
              text: message
            }
          ]
        }
      })

      if (result.error) {
        const errorMsg = result.error.data?.message || result.error.name || 'Failed to send message'
        throw new Error(errorMsg)
      }

      // Echo back to transcript
      this.sendToRenderer('agent:output', {
        sessionId,
        type: 'message',
        data: { role: 'user', content: message }
      })
    } catch (error) {
      console.error(`[AgentManager] Error sending message:`, error)
      throw error
    }
  }

  async respondToPermission(sessionId: string, approved: boolean, _message?: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    if (session.status !== 'waiting_approval') {
      console.warn(`[AgentManager] Session ${sessionId} is not waiting for approval`)
      return
    }

    console.log(`[AgentManager] Permission ${approved ? 'approved' : 'rejected'} for session ${sessionId}`)

    // TODO: Send permission response via OpenCode SDK when API is available
    // For now, just update the status

    if (approved) {
      session.status = 'working'
    } else {
      session.status = 'idle'
    }

    this.sendToRenderer('agent:status', {
      sessionId,
      agentId: session.agentId,
      taskId: session.taskId,
      status: session.status
    })
  }

  stopAllSessions(): void {
    console.log(`[AgentManager] Stopping all ${this.sessions.size} sessions`)
    for (const sessionId of this.sessions.keys()) {
      this.stopSession(sessionId)
    }
  }

  getSessionStatus(sessionId: string): { status: string; agentId: string; taskId: string } | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return {
      status: session.status,
      agentId: session.agentId,
      taskId: session.taskId
    }
  }

  getActiveSessionsForTask(taskId: string): string[] {
    const sessionIds: string[] = []
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.taskId === taskId && session.status !== 'error') {
        sessionIds.push(sessionId)
      }
    }
    return sessionIds
  }

  async getProviders(serverUrl?: string): Promise<{ providers: any[]; default: Record<string, string> } | null> {
    if (!OpenCodeSDK) {
      console.error('[AgentManager] OpenCode SDK not loaded')
      return null
    }

    try {
      // Use provided server URL or fall back to default agent's server URL
      let baseUrl = serverUrl
      
      if (!baseUrl) {
        const agents = this.db.getAgents()
        const defaultAgent = agents.find(a => a.is_default) || agents[0]
        baseUrl = defaultAgent?.server_url
      }
      
      if (!baseUrl) {
        console.error('[AgentManager] No server URL available')
        return null
      }

      const ocClient = OpenCodeSDK.createOpencodeClient({
        baseUrl
      })

      const result: any = await ocClient.config.providers()
      
      if (result.error) {
        console.error('[AgentManager] Failed to get providers:', result.error)
        return null
      }

      return result.data || null
    } catch (error) {
      console.error('[AgentManager] Error getting providers:', error)
      return null
    }
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }
}
