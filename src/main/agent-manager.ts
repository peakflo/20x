import { EventEmitter } from 'events'
import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, copyFileSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs'
import { pathToFileURL } from 'url'
import { Agent as UndiciAgent } from 'undici'
import type { BrowserWindow } from 'electron'
import type { DatabaseManager, AgentMcpServerEntry, OutputFieldRecord } from './database'
import { TaskStatus } from '../shared/constants'

let OpenCodeSDK: typeof import('@opencode-ai/sdk') | null = null

// Custom fetch with no timeout — agent prompts can run indefinitely
const noTimeoutAgent = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 })
const noTimeoutFetch = (req: any) => (globalThis as any).fetch(req, { dispatcher: noTimeoutAgent })

interface AgentSession {
  id: string
  agentId: string
  taskId: string
  workspaceDir?: string
  status: 'idle' | 'working' | 'error' | 'waiting_approval'
  createdAt: Date
  ocClient?: any
  ocSessionId?: string
  seenMessageIds: Set<string>
  seenPartIds: Set<string>
  partContentLengths: Map<string, string>
  pollTimer?: ReturnType<typeof setTimeout>
  promptAbort?: AbortController
  lastOcStatus?: string
  learningMode?: boolean
}

export class AgentManager extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map()
  private serverProcess: ChildProcess | null = null
  private serverUrl: string | null = null
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

  /**
   * Builds a `tools: { [name: string]: boolean }` filter from agent config.
   * If any MCP server has a subset of tools selected, we build an explicit
   * allow/deny map so OpenCode only enables those tools.
   * Returns undefined if all tools are enabled (no filtering needed).
   */
  private buildToolsFilter(agentId: string): Record<string, boolean> | undefined {
    const agent = this.db.getAgent(agentId)
    if (!agent?.config?.mcp_servers || agent.config.mcp_servers.length === 0) return undefined

    const entries = agent.config.mcp_servers
    let hasFiltering = false
    const toolsMap: Record<string, boolean> = {}

    for (const entry of entries) {
      const serverId = typeof entry === 'string' ? entry : (entry as AgentMcpServerEntry).serverId
      const enabledTools = typeof entry === 'string' ? undefined : (entry as AgentMcpServerEntry).enabledTools
      const mcpServer = this.db.getMcpServer(serverId)
      if (!mcpServer) continue

      if (enabledTools !== undefined && mcpServer.tools.length > 0) {
        // Selective — mark enabled tools true, others false
        hasFiltering = true
        const enabledSet = new Set(enabledTools)
        for (const tool of mcpServer.tools) {
          toolsMap[tool.name] = enabledSet.has(tool.name)
        }
      }
      // If enabledTools is undefined, all tools are allowed — no entries needed
    }

    return hasFiltering ? toolsMap : undefined
  }

  /**
   * Resolves and writes SKILL.md files to the workspace directory.
   * Priority: task.skill_ids > agent.config.skill_ids > all skills.
   */
  private writeSkillFiles(taskId: string, agentId: string, workspaceDir: string): void {
    try {
      const task = this.db.getTask(taskId)
      const agent = this.db.getAgent(agentId)
      const agentConfig = agent?.config as any

      // Resolve which skill IDs to use
      let skillIds: string[] | undefined
      if (task?.skill_ids !== null && task?.skill_ids !== undefined) {
        skillIds = task.skill_ids
      } else if (agentConfig?.skill_ids !== undefined) {
        skillIds = agentConfig.skill_ids
      }
      // undefined = all skills

      const skills = skillIds === undefined
        ? this.db.getSkills()
        : this.db.getSkillsByIds(skillIds)

      if (skills.length === 0) return

      const skillsDir = join(workspaceDir, '.agents', 'skills')
      for (const skill of skills) {
        const dir = join(skillsDir, skill.name)
        mkdirSync(dir, { recursive: true })
        const desc = skill.description || skill.name
        const content = `---\nname: ${skill.name}\ndescription: ${desc}\n---\n\n${skill.content}`
        writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
      }

      console.log(`[AgentManager] Wrote ${skills.length} SKILL.md file(s) to ${skillsDir}`)
    } catch (error) {
      console.error('[AgentManager] Error writing skill files:', error)
    }
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

        // Parse the actual server URL from stdout
        const urlMatch = output.match(/https?:\/\/[\w.:]+/)
        if (urlMatch) {
          this.serverUrl = urlMatch[0]
        }

        if (output.includes('ready') || output.includes('listening') || output.includes('http://')) {
          if (!isReady) {
            isReady = true
            clearTimeout(timeout)
            console.log(`[AgentManager] Server ready at ${this.serverUrl}`)
            resolve()
          }
        }
      })

      this.serverProcess.stderr?.on('data', (data) => {
        const output = data.toString()
        console.error('[OpenCode Server Error]', output)
        // Some servers output to stderr
        const urlMatch = output.match(/https?:\/\/[\w.:]+/)
        if (urlMatch && !this.serverUrl) {
          this.serverUrl = urlMatch[0]
        }
      })

      this.serverProcess.on('error', (error) => {
        console.error('[AgentManager] Server process error:', error)
        if (!isReady) {
          clearTimeout(timeout)
          reject(error)
        }
      })

      this.serverProcess.on('exit', (code) => {
        console.log(`[AgentManager] Server exited with code ${code}`)
        this.serverProcess = null
        this.serverUrl = null

        for (const session of this.sessions.values()) {
          session.status = 'error'
          this.db.updateTask(session.taskId, { status: TaskStatus.NotStarted })
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
      this.serverUrl = null
    }
  }

  /**
   * Resolves the actual server URL to use for an agent.
   * Uses the dynamically detected server URL from our spawned process,
   * falling back to the agent's configured URL.
   */
  private getServerUrl(agentServerUrl: string): string {
    if (this.serverUrl) return this.serverUrl
    return agentServerUrl
  }


  /**
   * Creates an OpenCode session and returns the sessionId immediately.
   * Uses promptAsync to send the initial prompt without blocking.
   */
  async startSession(agentId: string, taskId: string, workspaceDir?: string): Promise<string> {
    if (!OpenCodeSDK) {
      throw new Error('OpenCode SDK not loaded')
    }

    const agent = this.db.getAgent(agentId)
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    // Reuse existing session for this task
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.taskId === taskId && session.status !== 'error') {
        return sessionId
      }
    }

    // Always use a dedicated workspace directory
    if (!workspaceDir) {
      workspaceDir = this.db.getWorkspaceDir(taskId)
    }

    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const baseUrl = this.getServerUrl(agent.server_url)
    console.log(`[AgentManager] Starting session ${sessionId} for agent ${agentId}, server: ${baseUrl}`)

    const ocClient = OpenCodeSDK.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch as any })

    const session: AgentSession = {
      id: sessionId,
      agentId,
      taskId,
      workspaceDir,
      status: 'working',
      createdAt: new Date(),
      ocClient,
      seenMessageIds: new Set(),
      seenPartIds: new Set(),
      partContentLengths: new Map()
    }

    this.sessions.set(sessionId, session)

    try {
      // Write SKILL.md files to workspace before session creation
      this.writeSkillFiles(taskId, agentId, workspaceDir!)

      // Register MCP servers BEFORE creating session so the session picks them up
      const mcpEntries = agent.config?.mcp_servers || []
      const mcpServerIds = mcpEntries.map((e) => typeof e === 'string' ? e : (e as AgentMcpServerEntry).serverId)
      for (const serverId of mcpServerIds) {
        const mcpServer = this.db.getMcpServer(serverId)
        if (!mcpServer) continue

        try {
          const mcpConfig = mcpServer.type === 'remote'
            ? { type: 'remote' as const, url: mcpServer.url, headers: mcpServer.headers }
            : { type: 'local' as const, command: [mcpServer.command, ...mcpServer.args], environment: mcpServer.environment }
          const addResult: any = await ocClient.mcp.add({
            body: {
              name: mcpServer.name,
              config: mcpConfig
            },
            ...(workspaceDir && { query: { directory: workspaceDir } })
          })
          if (addResult.error) {
            console.error(`[AgentManager] mcp.add error for ${mcpServer.name}:`, addResult.error)
            continue
          }

          const connectResult = await ocClient.mcp.connect({
            path: { name: mcpServer.name },
            ...(workspaceDir && { query: { directory: workspaceDir } })
          })
          if (connectResult.error) {
            console.error(`[AgentManager] mcp.connect error for ${mcpServer.name}:`, connectResult.error)
            continue
          }

        } catch (mcpError) {
          console.error(`[AgentManager] Failed to register MCP server ${mcpServer.name}:`, mcpError)
        }
      }

      // Create OpenCode session
      const result: any = await ocClient.session.create({
        body: { title: `Task ${taskId}` },
        ...(workspaceDir && { query: { directory: workspaceDir } })
      })

      if (result.error) {
        throw new Error(result.error.data?.message || result.error.name || 'Failed to create session')
      }
      if (!result.data?.id) {
        throw new Error('No session ID returned from OpenCode')
      }

      session.ocSessionId = result.data.id
      console.log(`[AgentManager] OpenCode session created: ${result.data.id}`)

      // Update task status to agent_working
      this.db.updateTask(taskId, { status: TaskStatus.AgentWorking })

      // Notify renderer that session is live
      this.sendToRenderer('agent:status', {
        sessionId, agentId, taskId, status: 'working'
      })

      // Start polling for messages (SSE uses TextDecoderStream which isn't in Node)
      this.startPolling(sessionId)

      // Build the initial prompt
      const task = this.db.getTask(taskId)
      let promptText = task
        ? `Working on task: "${task.title}"\n\n${task.description || ''}`
        : `Working on task ${taskId}`

      // Append output field instructions if task has output fields
      if (task?.output_fields && task.output_fields.length > 0) {
        promptText += this.buildOutputFieldInstructions(task.output_fields)
      }

      // Copy all attachments to workspace and build parts
      const INLINE_MIMES = new Set([
        'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
        'application/pdf',
        'text/plain', 'text/csv', 'text/markdown', 'text/html',
        'application/json', 'application/xml'
      ])
      const attachmentRefs: string[] = []
      const parts: any[] = []
      if (task?.attachments?.length && workspaceDir) {
        const attachDir = this.db.getAttachmentsDir(taskId)
        const destDir = join(workspaceDir, 'attachments')
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

        for (const att of task.attachments) {
          const srcPath = join(attachDir, `${att.id}-${att.filename}`)
          if (!existsSync(srcPath)) continue

          // Copy to workspace
          const destPath = join(destDir, att.filename)
          try { copyFileSync(srcPath, destPath) } catch { continue }

          const canInline = INLINE_MIMES.has(att.mime_type) || att.mime_type.startsWith('text/')
          if (canInline) {
            parts.push({
              type: 'file',
              mime: att.mime_type,
              filename: att.filename,
              url: pathToFileURL(destPath).href
            })
          }
          attachmentRefs.push(`- attachments/${att.filename}`)
        }
      }
      if (attachmentRefs.length > 0) {
        promptText += `\n\nAttached files (relative to your working directory):\n${attachmentRefs.join('\n')}`
      }
      parts.unshift({ type: 'text', text: promptText })

      // Parse model from agent config (stored as "providerID/modelID")
      const agentConfig = agent.config as any
      let modelParam: { providerID: string; modelID: string } | undefined
      if (agentConfig?.model) {
        const slashIdx = agentConfig.model.indexOf('/')
        if (slashIdx > 0) {
          modelParam = {
            providerID: agentConfig.model.slice(0, slashIdx),
            modelID: agentConfig.model.slice(slashIdx + 1)
          }
        }
        console.log(`[AgentManager] Using model: ${agentConfig.model} →`, modelParam)
      }

      // Build tool filter from agent config
      const toolsFilter = this.buildToolsFilter(agentId)

      // Fire-and-forget prompt via SDK (SDK disables Node.js timeout internally)
      console.log(`[AgentManager] Sending prompt for session ${sessionId}${workspaceDir ? `, dir: ${workspaceDir}` : ''}`)
      const promptAbort = new AbortController()
      session.promptAbort = promptAbort
      ocClient.session.prompt({
        path: { id: session.ocSessionId },
        body: {
          parts,
          ...(modelParam && { model: modelParam }),
          ...(toolsFilter && { tools: toolsFilter })
        },
        ...(workspaceDir && { query: { directory: workspaceDir } }),
        signal: promptAbort.signal
      }).catch((err: any) => {
        if (err.name !== 'AbortError') {
          console.error('[AgentManager] prompt error:', err)
        }
      }).finally(() => {
        session.promptAbort = undefined
      })

      return sessionId
    } catch (error) {
      console.error(`[AgentManager] Failed to start session ${sessionId}:`, error)
      session.status = 'error'
      this.sessions.delete(sessionId)
      // Revert task status on error
      this.db.updateTask(taskId, { status: TaskStatus.NotStarted })
      throw error
    }
  }

  /**
   * Polls session status + messages every 2s to forward new content to the renderer.
   */
  private startPolling(sessionId: string): void {
    const poll = async (): Promise<void> => {
      const session = this.sessions.get(sessionId)
      if (!session || session.status === 'error') return

      await this.pollSessionStatus(sessionId)
      await this.fetchNewMessages(sessionId)

      // Schedule next poll
      if (this.sessions.has(sessionId)) {
        session.pollTimer = setTimeout(poll, 2000)
      }
    }

    // First poll after 1s (give promptAsync time to register)
    const session = this.sessions.get(sessionId)
    if (session) {
      session.pollTimer = setTimeout(poll, 1000)
    }
  }

  /**
   * Checks the OpenCode session status and forwards changes to the renderer.
   */
  private async pollSessionStatus(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.ocClient || !session.ocSessionId) return

    try {
      const statusResult: any = await session.ocClient.session.status({
        ...(session.workspaceDir && { query: { directory: session.workspaceDir } })
      })

      if (!statusResult.data) return

      const ocStatus = statusResult.data[session.ocSessionId]
      const statusKey = ocStatus ? JSON.stringify(ocStatus) : undefined

      // Only log + notify on change
      if (statusKey === session.lastOcStatus) return
      session.lastOcStatus = statusKey

      if (!ocStatus || ocStatus.type === 'idle') {
        await this.transitionToIdle(sessionId, session)
      } else if (ocStatus.type === 'busy') {
        session.status = 'working'
        if (!session.learningMode) {
          this.sendToRenderer('agent:status', {
            sessionId, agentId: session.agentId, taskId: session.taskId, status: 'working'
          })
        }
      } else if (ocStatus.type === 'retry') {
        this.sendToRenderer('agent:output', {
          sessionId,
          taskId: session.taskId,
          type: 'message',
          data: {
            id: `retry-${Date.now()}`,
            role: 'system',
            content: ocStatus.message || 'Rate limit exceeded',
            partType: 'error'
          }
        })
        await this.abortSession(sessionId)
      }
    } catch (error) {
      console.error(`[AgentManager] Error checking session status:`, error)
    }
  }

  /**
   * Transitions a session to idle and notifies the renderer.
   * Extracts output field values BEFORE notifying so the renderer
   * picks up the updated task data on re-fetch.
   */
  private async transitionToIdle(sessionId: string, session: AgentSession): Promise<void> {
    if (session.status === 'idle') return
    session.status = 'idle'
    console.log(`[AgentManager] Session ${sessionId} → idle`)

    // In learning mode, skip output extraction, task status, and renderer notification
    if (session.learningMode) return

    // Extract output field values BEFORE notifying the renderer
    try {
      await this.extractOutputValues(sessionId)
    } catch (err) {
      console.error(`[AgentManager] extractOutputValues error:`, err)
    }

    // Update task status to ready_for_review
    this.db.updateTask(session.taskId, { status: TaskStatus.ReadyForReview })

    this.sendToRenderer('agent:status', {
      sessionId, agentId: session.agentId, taskId: session.taskId, status: 'idle'
    })
  }

  /**
   * Builds the renderer payload for a single Part.
   * Returns null for internal parts that should be skipped.
   */
  private buildPartPayload(part: any): { content: string; partType: string; tool?: any } | null {
    switch (part.type) {
      case 'text':
        return part.text ? { content: part.text, partType: 'text' } : null

      case 'reasoning':
        return part.text ? { content: part.text, partType: 'reasoning' } : null

      case 'tool': {
        const toolName = part.tool || 'unknown'
        const state = part.state || {}
        const status = state.status || 'unknown'
        const title = state.title || ''
        const inputStr = state.input && Object.keys(state.input).length > 0
          ? JSON.stringify(state.input, null, 2) : undefined
        const outputStr = status === 'completed' && state.output
          ? state.output.slice(0, 2000) : undefined
        const errorStr = status === 'error' && state.error ? state.error : undefined

        // Interactive question tool — detect by questions array in input
        let questions = state.input?.questions
        if (typeof questions === 'string') {
          try { questions = JSON.parse(questions) } catch {}
        }
        if (Array.isArray(questions) && questions.length > 0) {
          return {
            content: title || 'Question',
            partType: 'question',
            tool: {
              name: toolName,
              status,
              title,
              input: inputStr,
              output: outputStr,
              error: errorStr,
              questions
            }
          }
        }

        // TodoWrite tool — detect by todos array in input
        let todos = state.input?.todos
        if (typeof todos === 'string') {
          try { todos = JSON.parse(todos) } catch {}
        }
        if (Array.isArray(todos) && todos.length > 0) {
          return {
            content: title || 'Todo List',
            partType: 'todowrite',
            tool: {
              name: toolName,
              status,
              title,
              input: inputStr,
              output: outputStr,
              error: errorStr,
              todos
            }
          }
        }

        return {
          content: title ? `${toolName} — ${title}` : toolName,
          partType: 'tool',
          tool: { name: toolName, status, title, input: inputStr, output: outputStr, error: errorStr }
        }
      }

      case 'file':
        return { content: `📎 ${part.filename || part.url || 'file'} (${part.mime || ''})`, partType: 'file' }

      case 'step-start':
        return { content: 'Step started', partType: 'step-start' }

      case 'step-finish': {
        const t = part.tokens
        const info = t ? ` (in:${t.input} out:${t.output} cache:${t.cache?.read || 0})` : ''
        return { content: `Step finished: ${part.reason || ''}${info}`, partType: 'step-finish' }
      }

      case 'agent':
        return { content: `Agent: ${part.name || 'unknown'}`, partType: 'agent' }

      case 'subtask':
        return { content: `Subtask: ${part.description || part.prompt || ''}`, partType: 'subtask' }

      case 'retry':
        return { content: `Retry #${part.attempt}: ${part.error?.message || JSON.stringify(part.error)}`, partType: 'retry' }

      case 'compaction':
        return { content: `Context compaction${part.auto ? ' (auto)' : ''}`, partType: 'compaction' }

      case 'snapshot':
      case 'patch':
        return null

      default:
        return { content: part.text || JSON.stringify(part).slice(0, 200), partType: part.type || 'unknown' }
    }
  }

  /**
   * Fetches messages from OpenCode and forwards new parts to the renderer.
   * Sends each part individually so the UI gets incremental updates.
   */
  private async fetchNewMessages(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.ocClient || !session.ocSessionId) return

    try {
      const messagesResult: any = await session.ocClient.session.messages({
        path: { id: session.ocSessionId },
        ...(session.workspaceDir && { query: { directory: session.workspaceDir } })
      })

      if (!messagesResult.data || !Array.isArray(messagesResult.data)) return

      let newPartCount = 0

      for (const msg of messagesResult.data) {
        if (!msg.info) continue

        const msgId = msg.info.id
        const role = msg.info.role || 'assistant'
        const parts = msg.parts && Array.isArray(msg.parts) ? msg.parts : []
        const isCompleted = msg.info.time?.completed != null

        if (!session.seenMessageIds.has(msgId)) {
          session.seenMessageIds.add(msgId)
        }

        // Process each part — send new ones, update streaming text/reasoning parts
        for (const part of parts) {
          const partId = part.id
          if (!partId) continue

          const payload = this.buildPartPayload(part)
          if (payload === null) {
            session.seenPartIds.add(partId)
            continue
          }

          const isUpdatable = part.type === 'text' || part.type === 'reasoning' || part.type === 'tool'
          // For text/reasoning track content length; for tools track status+output+partType
          const fingerprint = part.type === 'tool'
            ? `${part.state?.status}:${payload.partType}:${payload.content.length}:${payload.tool?.output?.length ?? 0}`
            : String(payload.content.length)

          if (session.seenPartIds.has(partId)) {
            // Already sent — check if content has changed
            if (isUpdatable) {
              const prevFingerprint = session.partContentLengths.get(partId)
              if (fingerprint !== prevFingerprint) {
                session.partContentLengths.set(partId, fingerprint)
                this.sendToRenderer('agent:output', {
                  sessionId,
                  taskId: session.taskId,
                  type: 'message',
                  data: {
                    id: partId,
                    role,
                    content: payload.content,
                    partType: payload.partType,
                    tool: payload.tool,
                    update: true
                  }
                })
              }
            }
            continue
          }

          session.seenPartIds.add(partId)
          if (isUpdatable) {
            session.partContentLengths.set(partId, fingerprint)
          }
          newPartCount++

          this.sendToRenderer('agent:output', {
            sessionId,
            taskId: session.taskId,
            type: 'message',
            data: {
              id: partId,
              role,
              content: payload.content,
              partType: payload.partType,
              tool: payload.tool
            }
          })
        }

        // If assistant message has an error, forward it with readable message
        if (role === 'assistant' && msg.info.error) {
          const errId = `error-${msgId}`
          if (!session.seenPartIds.has(errId)) {
            session.seenPartIds.add(errId)
            const err = msg.info.error
            const errMsg = err.data?.message || err.message || err.name || JSON.stringify(err)
            this.sendToRenderer('agent:output', {
              sessionId,
              taskId: session.taskId,
              type: 'message',
              data: { id: errId, role: 'system', content: errMsg, partType: 'error' }
            })
          }
        }

        // Empty incomplete assistant message — model hasn't started producing parts yet, just wait
        if (
          role === 'assistant' &&
          !isCompleted &&
          parts.length === 0 &&
          !msg.info.error
        ) {
          const pendingId = `pending-${msgId}`
          if (!session.seenPartIds.has(pendingId)) {
            session.seenPartIds.add(pendingId)
          }
        }
      }

      // Detect completion from messages: if the last assistant message is completed
      // and session is still 'working', transition to idle
      if (session.status === 'working') {
        const lastAssistantMsg = [...messagesResult.data]
          .reverse()
          .find((m: any) => m.info?.role === 'assistant')

        if (lastAssistantMsg?.info?.time?.completed) {
          await this.transitionToIdle(sessionId, session)
        }
      }
    } catch (error) {
      console.error(`[AgentManager] Error fetching messages for ${sessionId}:`, error)
    }
  }

  /**
   * Interrupts the current generation, stops polling, keeps transcript.
   */
  async abortSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    console.log(`[AgentManager] Aborting session ${sessionId}`)

    // Stop polling and cancel pending HTTP prompt
    if (session.pollTimer) {
      clearTimeout(session.pollTimer)
      session.pollTimer = undefined
    }
    if (session.promptAbort) {
      session.promptAbort.abort()
      session.promptAbort = undefined
    }

    if (session.ocClient && session.ocSessionId) {
      try {
        await session.ocClient.session.abort({
          path: { id: session.ocSessionId }
        })
      } catch (error) {
        console.error(`[AgentManager] Error aborting session:`, error)
      }
    }

    // One final message fetch to capture any remaining output
    await this.fetchNewMessages(sessionId)

    session.status = 'idle'
    this.db.updateTask(session.taskId, { status: TaskStatus.NotStarted })
    this.sendToRenderer('agent:status', {
      sessionId,
      agentId: session.agentId,
      taskId: session.taskId,
      status: 'idle'
    })
  }

  /**
   * Fully destroys the session — stops polling, removes from map.
   */
  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      console.log(`[AgentManager] Session ${sessionId} not found`)
      return
    }

    console.log(`[AgentManager] Destroying session ${sessionId}`)

    if (session.pollTimer) {
      clearTimeout(session.pollTimer)
      session.pollTimer = undefined
    }
    if (session.promptAbort) {
      session.promptAbort.abort()
      session.promptAbort = undefined
    }

    if (session.ocClient && session.ocSessionId) {
      try {
        await session.ocClient.session.abort({
          path: { id: session.ocSessionId }
        })
      } catch (error) {
        console.error(`[AgentManager] Error aborting session:`, error)
      }
    }

    this.sessions.delete(sessionId)
    // Revert task status on stop
    this.db.updateTask(session.taskId, { status: TaskStatus.NotStarted })
    this.sendToRenderer('agent:status', {
      sessionId,
      agentId: session.agentId,
      taskId: session.taskId,
      status: 'idle'
    })
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    if (session.status === 'error') throw new Error('Session is in error state')
    if (!session.ocClient || !session.ocSessionId) throw new Error('OpenCode session not initialized')

    console.log(`[AgentManager] Sending message to session ${sessionId}`)

    // Resume working state and restart polling if needed
    session.status = 'working'
    this.db.updateTask(session.taskId, { status: TaskStatus.AgentWorking })
    this.sendToRenderer('agent:status', {
      sessionId, agentId: session.agentId, taskId: session.taskId, status: 'working'
    })
    if (!session.pollTimer) {
      this.startPolling(sessionId)
    }

    // Resolve model from agent config
    const agent = this.db.getAgent(session.agentId)
    const agentConfig = agent?.config as any
    let modelParam: { providerID: string; modelID: string } | undefined
    if (agentConfig?.model) {
      const slashIdx = agentConfig.model.indexOf('/')
      if (slashIdx > 0) {
        modelParam = {
          providerID: agentConfig.model.slice(0, slashIdx),
          modelID: agentConfig.model.slice(slashIdx + 1)
        }
      }
    }

    // Build tool filter
    const toolsFilter = this.buildToolsFilter(session.agentId)

    // Fire-and-forget prompt via SDK
    const promptAbort = new AbortController()
    session.promptAbort = promptAbort
    session.ocClient.session.prompt({
      path: { id: session.ocSessionId },
      body: {
        parts: [{ type: 'text', text: message }],
        ...(modelParam && { model: modelParam }),
        ...(toolsFilter && { tools: toolsFilter })
      },
      ...(session.workspaceDir && { query: { directory: session.workspaceDir } }),
      signal: promptAbort.signal
    }).catch((err: any) => {
      if (err.name !== 'AbortError') {
        console.error('[AgentManager] sendMessage error:', err)
      }
    }).finally(() => {
      session.promptAbort = undefined
    })
  }

  async respondToPermission(sessionId: string, approved: boolean, _message?: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    console.log(`[AgentManager] Permission ${approved ? 'approved' : 'rejected'} for session ${sessionId}`)

    // TODO: Use postSessionIdPermissionsPermissionId when we have the permissionID
    // For now, update status
    session.status = approved ? 'working' : 'idle'

    this.sendToRenderer('agent:status', {
      sessionId,
      agentId: session.agentId,
      taskId: session.taskId,
      status: session.status
    })
  }

  stopAllSessions(): void {
    console.log(`[AgentManager] Stopping all ${this.sessions.size} sessions`)
    for (const sessionId of [...this.sessions.keys()]) {
      this.stopSession(sessionId)
    }
  }

  getSessionStatus(sessionId: string): { status: string; agentId: string; taskId: string } | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return { status: session.status, agentId: session.agentId, taskId: session.taskId }
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

  /**
   * Tests an MCP server by speaking the MCP protocol directly
   * (JSON-RPC over stdio for local, HTTP POST for remote).
   */
  async testMcpServer(serverData: { name: string; type?: string; command?: string; args?: string[]; url?: string; headers?: Record<string, string>; environment?: Record<string, string> }): Promise<{ status: 'connected' | 'failed'; error?: string; toolCount?: number; tools?: { name: string; description: string }[] }> {
    if (serverData.type === 'remote') {
      return this.testRemoteMcpServer(serverData)
    }
    return this.testLocalMcpServer(serverData)
  }

  private testLocalMcpServer(serverData: { name: string; command?: string; args?: string[]; environment?: Record<string, string> }): Promise<{ status: 'connected' | 'failed'; error?: string; toolCount?: number; tools?: { name: string; description: string }[] }> {
    if (!serverData.command) {
      return Promise.resolve({ status: 'failed', error: 'No command specified' })
    }

    return new Promise((resolve) => {
      let resolved = false
      const finish = (result: { status: 'connected' | 'failed'; error?: string; toolCount?: number; tools?: { name: string; description: string }[] }): void => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        try { proc.kill('SIGTERM') } catch {}
        resolve(result)
      }

      const timer = setTimeout(() => {
        finish({ status: 'failed', error: 'Connection timeout (30s)' })
      }, 30000)

      // Build a single shell command with proper quoting — args containing spaces
      // must be quoted so the shell doesn't split them (e.g. "Authorization: Bearer ...")
      const shellCmd = [serverData.command!, ...(serverData.args || [])].map((arg) =>
        /[\s"'\\$`!#&|;()<>]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg
      ).join(' ')
      const proc = spawn(shellCmd, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: { ...process.env, npm_config_yes: 'true', ...(serverData.environment || {}) }
      })

      let buffer = ''
      let stderrBuf = ''
      let phase: 'init' | 'tools' = 'init'

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString()
      })

      const handleMessage = (msg: any): void => {
        if (msg.error) {
          finish({ status: 'failed', error: msg.error.message || JSON.stringify(msg.error) })
          return
        }

        if (phase === 'init' && msg.id === 1 && msg.result) {
          phase = 'tools'
          // Send initialized notification + tools/list request
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
        } else if (phase === 'tools' && msg.id === 2 && msg.result) {
          const rawTools = Array.isArray(msg.result.tools) ? msg.result.tools : []
          const tools = rawTools.map((t: any) => ({ name: t.name || '', description: t.description || '' }))
          finish({ status: 'connected', toolCount: tools.length, tools })
        }
      }

      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        // Parse newline-delimited JSON messages
        let idx: number
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          try { handleMessage(JSON.parse(line)) } catch {}
        }
        // Try parsing buffer as complete JSON (server may not send trailing newline)
        if (buffer.trim()) {
          try {
            const msg = JSON.parse(buffer.trim())
            buffer = ''
            handleMessage(msg)
          } catch {}
        }
      })

      proc.on('error', (err) => {
        finish({ status: 'failed', error: err.message })
      })

      proc.on('exit', (code) => {
        const errMsg = stderrBuf.trim().split('\n').pop() || `Process exited with code ${code}`
        finish({ status: 'failed', error: errMsg })
      })

      // Send initialize
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'pf-desktop', version: '1.0.0' }
        }
      }) + '\n')
    })
  }

  private async testRemoteMcpServer(serverData: { name: string; url?: string; headers?: Record<string, string> }): Promise<{ status: 'connected' | 'failed'; error?: string; toolCount?: number; tools?: { name: string; description: string }[] }> {
    if (!serverData.url) {
      return { status: 'failed', error: 'No URL specified' }
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...serverData.headers }

      // Try streamable HTTP — POST initialize directly
      const initRes = await fetch(serverData.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pf-desktop', version: '1.0.0' } }
        }),
        signal: AbortSignal.timeout(10000)
      })

      if (!initRes.ok) {
        return { status: 'failed', error: `HTTP ${initRes.status}: ${initRes.statusText}` }
      }

      const contentType = initRes.headers.get('content-type') || ''

      if (contentType.includes('application/json')) {
        const initData = await initRes.json()
        if (initData.error) {
          return { status: 'failed', error: initData.error.message || 'Initialize failed' }
        }

        // Send initialized notification (fire-and-forget)
        fetch(serverData.url, {
          method: 'POST', headers,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
        }).catch(() => {})

        // Request tools
        const toolsRes = await fetch(serverData.url, {
          method: 'POST', headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
          signal: AbortSignal.timeout(10000)
        })
        const toolsData = await toolsRes.json()
        const rawTools = Array.isArray(toolsData.result?.tools) ? toolsData.result.tools : []
        const tools = rawTools.map((t: any) => ({ name: t.name || '', description: t.description || '' }))
        return { status: 'connected', toolCount: tools.length, tools }
      }

      // Non-JSON response (SSE or other) — server is reachable but uses SSE transport
      return { status: 'connected' }
    } catch (error: any) {
      return { status: 'failed', error: error?.message || 'Connection failed' }
    }
  }

  async getProviders(serverUrl?: string, directory?: string): Promise<{ providers: any[]; default: Record<string, string> } | null> {
    if (!OpenCodeSDK) return null

    try {
      let baseUrl = serverUrl
      if (!baseUrl) {
        // Use actual server URL if we have it
        baseUrl = this.serverUrl || undefined
      }
      if (!baseUrl) {
        const agents = this.db.getAgents()
        const defaultAgent = agents.find((a) => a.is_default) || agents[0]
        baseUrl = defaultAgent?.server_url
      }
      if (!baseUrl) return null

      // Default to home directory so project-scoped OpenCode configs are picked up
      const dir = directory || require('os').homedir()

      const ocClient = OpenCodeSDK.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch as any })
      const result: any = await ocClient.config.providers({
        query: { directory: dir }
      })

      if (result.error) {
        console.error('[AgentManager] Providers API error:', result.error)
        return null
      }

      return result.data || null
    } catch (error) {
      console.error('[AgentManager] Error getting providers:', error)
      return null
    }
  }

  /**
   * Builds instructions for the agent about output fields to fill.
   */
  private buildOutputFieldInstructions(fields: OutputFieldRecord[]): string {
    const lines: string[] = [
      '\n\n---',
      'When you complete this task, provide the following outputs.',
      'Include your answers in a JSON code block at the end of your final message.',
      'Use the exact field names as keys:\n'
    ]

    // Build example JSON
    const exampleObj: Record<string, string> = {}
    for (const field of fields) {
      const attrs: string[] = [field.type]
      if (field.required) attrs.push('required')
      if (field.multiple) attrs.push('multiple')
      if (field.options?.length) attrs.push(`options: ${field.options.join(', ')}`)

      lines.push(`- ${field.name} (${attrs.join(', ')})`)
      exampleObj[field.name] = field.type === 'file' ? '</absolute/path/to/file>' : `<${field.type} value>`
    }

    const hasFileFields = fields.some((f) => f.type === 'file')
    if (hasFileFields) {
      lines.push('\nFor file fields, return the absolute path to the file you created.')
    }

    lines.push('\nExample format:')
    lines.push('```json')
    lines.push(JSON.stringify(exampleObj, null, 2))
    lines.push('```')

    return lines.join('\n')
  }

  /**
   * Extracts output field values from the last assistant message
   * and from the outputs directory on session completion.
   */
  private async extractOutputValues(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.ocClient || !session.ocSessionId) return

    const task = this.db.getTask(session.taskId)
    if (!task?.output_fields || task.output_fields.length === 0) return

    try {
      // Fetch messages to find last assistant text
      const messagesResult: any = await session.ocClient.session.messages({
        path: { id: session.ocSessionId },
        ...(session.workspaceDir && { query: { directory: session.workspaceDir } })
      })

      if (!messagesResult.data || !Array.isArray(messagesResult.data)) return

      // Collect all assistant messages (not just last) for text + tool extraction
      const assistantMessages = messagesResult.data.filter((m: any) => m.info?.role === 'assistant')

      let parsedValues: Record<string, unknown> = {}

      // Collect file paths from completed write/edit tool calls
      const writtenFiles: string[] = []
      for (const msg of assistantMessages) {
        if (!msg.parts) continue
        for (const part of msg.parts) {
          if (part.type !== 'tool' || part.state?.status !== 'completed') continue
          const toolName = (part.tool || '').toLowerCase()
          if (toolName === 'write' || toolName === 'edit' || toolName === 'create_file') {
            const input = part.state?.input || {}
            const filePath = input.file_path || input.path || input.filename
            if (filePath) writtenFiles.push(filePath)
          }
        }
      }
      if (writtenFiles.length > 0) {
        console.log(`[AgentManager] Found ${writtenFiles.length} written file(s):`, writtenFiles)
      }

      // Extract JSON block from ALL assistant text (search last message first, then earlier ones)
      for (let i = assistantMessages.length - 1; i >= 0; i--) {
        const msg = assistantMessages[i]
        if (!msg.parts) continue
        const fullText = msg.parts
          .filter((p: any) => p.type === 'text' && p.text)
          .map((p: any) => p.text)
          .join('\n')
        if (!fullText) continue

        const jsonMatch = fullText.match(/```json\s*\n?([\s\S]*?)\n?\s*```/)
          || fullText.match(/```\s*\n?([\s\S]*?)\n?\s*```/)
        if (jsonMatch) {
          try {
            parsedValues = JSON.parse(jsonMatch[1].trim())
            console.log(`[AgentManager] Parsed output values:`, parsedValues)
            break
          } catch (e) {
            console.log(`[AgentManager] Failed to parse output JSON: "${jsonMatch[1].trim()}"`, e)
          }
        }
      }

      if (Object.keys(parsedValues).length === 0) {
        console.log(`[AgentManager] No JSON output block found in assistant messages`)
      }

      // Build lookup maps: name → value and id → value (case-insensitive name match)
      const byName = new Map<string, unknown>()
      const byId = new Map<string, unknown>()
      for (const [key, value] of Object.entries(parsedValues)) {
        byId.set(key, value)
        byName.set(key.toLowerCase(), value)
      }

      // Map parsed values to fields — match by name first, then by id
      const updatedFields = task.output_fields.map((field) => {
        const updated = { ...field }

        const valueByName = byName.get(field.name.toLowerCase())
        const valueById = byId.get(field.id)
        if (valueByName !== undefined) {
          updated.value = valueByName
        } else if (valueById !== undefined) {
          updated.value = valueById
        }

        // For file fields: use written file paths from tool calls
        if (field.type === 'file' && !updated.value && writtenFiles.length > 0) {
          updated.value = field.multiple ? writtenFiles : writtenFiles[0]
        }

        return updated
      })

      // Save updated output fields
      this.db.updateTask(session.taskId, { output_fields: updatedFields })
      console.log(`[AgentManager] Extracted output values for task ${session.taskId}`)
    } catch (error) {
      console.error(`[AgentManager] Error extracting output values:`, error)
    }
  }

  /**
   * Parses a SKILL.md file's raw content into name, description, and content.
   * Expected format: ---\nname: ...\ndescription: ...\n---\n\ncontent
   */
  private parseSkillMd(raw: string): { name: string; description: string; content: string } | null {
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n\n?([\s\S]*)$/)
    if (!match) return null

    const frontmatter = match[1]
    const content = match[2].trim()

    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
    if (!nameMatch) return null

    const name = nameMatch[1].trim()
    const description = descMatch ? descMatch[1].trim() : ''

    // Validate name pattern
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return null

    return { name, description, content }
  }

  /**
   * Scans .opencode/skills/ in the session's workspace, compares with DB,
   * and creates/updates skills that have changed.
   */
  syncSkillsFromWorkspace(sessionId: string): { created: string[]; updated: string[]; unchanged: string[] } {
    const session = this.sessions.get(sessionId)
    if (!session?.workspaceDir) {
      return { created: [], updated: [], unchanged: [] }
    }

    // Scan both .agents/skills/ (new) and .opencode/skills/ (legacy/agent-created)
    const skillsDirs = [
      join(session.workspaceDir, '.agents', 'skills'),
      join(session.workspaceDir, '.opencode', 'skills')
    ].filter(existsSync)
    if (skillsDirs.length === 0) {
      return { created: [], updated: [], unchanged: [] }
    }

    const result = { created: [] as string[], updated: [] as string[], unchanged: [] as string[] }
    const seen = new Set<string>()

    for (const skillsDir of skillsDirs) {
    let entries: string[]
    try {
      entries = readdirSync(skillsDir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = join(skillsDir, entry)
      let skillFile: string
      let fallbackName: string | undefined

      try {
        const st = statSync(entryPath)
        if (st.isDirectory()) {
          // .opencode/skills/<name>/SKILL.md
          skillFile = join(entryPath, 'SKILL.md')
          if (!existsSync(skillFile)) continue
          fallbackName = entry.replace(/_/g, '-')
        } else if (entry.endsWith('.md')) {
          // .opencode/skills/<name>.md (flat file)
          skillFile = entryPath
          fallbackName = entry.replace(/\.md$/, '').replace(/_/g, '-')
        } else {
          continue
        }
      } catch {
        continue
      }

      let raw: string
      try {
        raw = readFileSync(skillFile, 'utf-8')
      } catch {
        continue
      }

      // Try frontmatter parse; fall back to deriving name from filename
      let parsed = this.parseSkillMd(raw)
      if (!parsed && fallbackName && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(fallbackName)) {
        parsed = { name: fallbackName, description: '', content: raw.trim() }
      }
      if (!parsed) continue
      if (seen.has(parsed.name)) continue
      seen.add(parsed.name)

      const existing = this.db.getSkillByName(parsed.name)
      if (existing) {
        // Only update if content or description changed
        if (existing.content !== parsed.content || existing.description !== parsed.description) {
          this.db.updateSkill(existing.id, {
            description: parsed.description,
            content: parsed.content
          })
          result.updated.push(parsed.name)
        } else {
          result.unchanged.push(parsed.name)
        }
      } else {
        this.db.createSkill({
          name: parsed.name,
          description: parsed.description,
          content: parsed.content
        })
        result.created.push(parsed.name)
      }
    }
    } // end skillsDirs loop

    console.log(`[AgentManager] Skill sync: created=${result.created.length}, updated=${result.updated.length}, unchanged=${result.unchanged.length}`)
    return result
  }

  /**
   * Finds the session for a given taskId and syncs skills from its workspace.
   */
  syncSkillsForTask(taskId: string): { created: string[]; updated: string[]; unchanged: string[] } {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.taskId === taskId) {
        return this.syncSkillsFromWorkspace(sessionId)
      }
    }
    return { created: [], updated: [], unchanged: [] }
  }

  /**
   * Sends feedback to the agent, waits for completion, syncs skills, and cleans up.
   * Runs entirely on main process — renderer can fire-and-forget.
   * Does NOT change task status at any point.
   */
  async learnFromSession(sessionId: string, feedbackMessage: string): Promise<{ created: string[]; updated: string[]; unchanged: string[] }> {
    const session = this.sessions.get(sessionId)
    if (!session?.ocClient || !session.ocSessionId) {
      return { created: [], updated: [], unchanged: [] }
    }

    console.log(`[AgentManager] Learning from session ${sessionId}`)
    session.learningMode = true

    // Resolve model from agent config
    const agent = this.db.getAgent(session.agentId)
    const agentConfig = agent?.config as any
    let modelParam: { providerID: string; modelID: string } | undefined
    if (agentConfig?.model) {
      const slashIdx = agentConfig.model.indexOf('/')
      if (slashIdx > 0) {
        modelParam = {
          providerID: agentConfig.model.slice(0, slashIdx),
          modelID: agentConfig.model.slice(slashIdx + 1)
        }
      }
    }

    const toolsFilter = this.buildToolsFilter(session.agentId)

    // Send feedback prompt — await blocks until agent finishes
    try {
      await session.ocClient.session.prompt({
        path: { id: session.ocSessionId },
        body: {
          parts: [{ type: 'text', text: feedbackMessage }],
          ...(modelParam && { model: modelParam }),
          ...(toolsFilter && { tools: toolsFilter })
        },
        ...(session.workspaceDir && { query: { directory: session.workspaceDir } })
      })
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error('[AgentManager] learnFromSession prompt error:', err)
      }
    }

    // Stop polling
    if (session.pollTimer) {
      clearTimeout(session.pollTimer)
      session.pollTimer = undefined
    }

    // Sync skills from workspace
    const result = this.syncSkillsFromWorkspace(sessionId)

    // Clean up session without changing task status
    this.sessions.delete(sessionId)
    console.log(`[AgentManager] Learning complete for session ${sessionId}:`, result)
    return result
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    }
  }
}
