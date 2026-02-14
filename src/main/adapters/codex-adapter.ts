/**
 * Codex Adapter
 *
 * Implements CodingAgentAdapter for OpenAI Codex via direct CLI integration.
 *
 * Key differences from Claude Code:
 * - Uses JSON-RPC over stdio (like MCP protocol)
 * - Spawns `codex` CLI process per session
 * - Thread-based session model (thread_id instead of session_id)
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import type {
  CodingAgentAdapter,
  SessionConfig,
  SessionStatus,
  SessionMessage,
  MessagePart,
} from './coding-agent-adapter'
import { SessionStatusType, MessagePartType, MessageRole } from './coding-agent-adapter'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number | string
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

interface CodexMessage {
  type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'thinking'
  id: string
  role?: 'user' | 'assistant' | 'system'
  content?: string
  delta?: string
  tool_name?: string
  tool_call_id?: string
  arguments?: Record<string, unknown>
  result?: string
  error?: string
  finished?: boolean
}

interface CodexSession {
  threadId: string // Codex thread ID
  process: ChildProcess
  workspaceDir: string
  messageBuffer: CodexMessage[]
  status: 'idle' | 'busy' | 'error'
  abortController: AbortController
  config: SessionConfig
  lastError: string | null
  nextRpcId: number
  pendingRpcCalls: Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>
  stdoutBuffer: string
}

export class CodexAdapter implements CodingAgentAdapter {
  private sessions = new Map<string, CodexSession>()
  private codexExecutablePath: string | null = null

  async initialize(): Promise<void> {
    // Find codex CLI executable
    this.codexExecutablePath = await this.findCodexExecutable()
    console.log(`[CodexAdapter] Initialized with executable: ${this.codexExecutablePath}`)
  }

  /**
   * Find the Codex CLI executable path
   */
  private async findCodexExecutable(): Promise<string> {
    if (this.codexExecutablePath) {
      return this.codexExecutablePath
    }

    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFile)

      // Try to find codex in PATH
      const { stdout } = await execFileAsync('which', ['codex'])
      this.codexExecutablePath = stdout.trim()
      console.log(`[CodexAdapter] Found codex executable at: ${this.codexExecutablePath}`)
      return this.codexExecutablePath
    } catch (error) {
      // Common installation locations
      const commonPaths = [
        '/usr/local/bin/codex',
        '/opt/homebrew/bin/codex',
        `${process.env.HOME}/.local/bin/codex`,
        `${process.env.HOME}/.npm-global/bin/codex`,
      ]

      for (const path of commonPaths) {
        if (existsSync(path)) {
          this.codexExecutablePath = path
          console.log(`[CodexAdapter] Found codex executable at: ${this.codexExecutablePath}`)
          return this.codexExecutablePath
        }
      }

      throw new Error(
        'Codex CLI not found. Install it from OpenAI: https://platform.openai.com/docs/codex'
      )
    }
  }

  /**
   * Build environment variables for Codex process
   */
  private buildCodexEnvironment(): Record<string, string> {
    const env = { ...process.env } as Record<string, string>

    // Ensure API key is available
    if (!env.OPENAI_API_KEY && !env.CODEX_API_KEY) {
      console.warn('[CodexAdapter] No OPENAI_API_KEY or CODEX_API_KEY found in environment')
    }

    return env
  }

  async createSession(config: SessionConfig): Promise<string> {
    if (!this.codexExecutablePath) {
      throw new Error('Codex executable not found')
    }

    const abortController = new AbortController()

    // Spawn codex process
    const codexProcess = spawn(
      this.codexExecutablePath,
      [
        '--model',
        config.model || 'gpt-5.3-codex',
        '--json-rpc', // Enable JSON-RPC mode
      ],
      {
        cwd: config.workspaceDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.buildCodexEnvironment(),
      }
    )

    // Create session state
    const session: CodexSession = {
      threadId: '', // Will be set after thread.create
      process: codexProcess,
      workspaceDir: config.workspaceDir,
      messageBuffer: [],
      status: 'idle',
      abortController,
      config,
      lastError: null,
      nextRpcId: 1,
      pendingRpcCalls: new Map(),
      stdoutBuffer: '',
    }

    // Set up stdout parser
    this.setupStdoutParser(codexProcess, session)

    // Set up stderr logging
    codexProcess.stderr?.on('data', (chunk: Buffer) => {
      console.error('[CodexAdapter] Codex stderr:', chunk.toString())
    })

    // Handle process exit
    codexProcess.on('exit', (code, signal) => {
      console.log(`[CodexAdapter] Codex process exited: code=${code}, signal=${signal}`)
      if (code !== 0 && code !== null) {
        session.status = 'error'
        session.lastError = `Codex process exited with code ${code}`
      }
    })

    // Initialize JSON-RPC session
    try {
      const apiKey = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY
      await this.sendRpcRequest(session, 'initialize', {
        api_key: apiKey,
        model: config.model || 'gpt-5.3-codex',
      })

      // Create thread (Codex's session concept)
      const threadResponse = (await this.sendRpcRequest(session, 'thread.create', {})) as {
        thread_id: string
      }

      session.threadId = threadResponse.thread_id
      console.log(`[CodexAdapter] Created Codex thread: ${session.threadId}`)

      // Store session
      this.sessions.set(session.threadId, session)

      return session.threadId
    } catch (error: any) {
      // Cleanup on error
      codexProcess.kill()
      throw new Error(`Failed to create Codex session: ${error.message}`)
    }
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    if (!this.codexExecutablePath) {
      throw new Error('Codex executable not found')
    }

    // Validate session ID format (Codex uses thread_xxx format)
    if (!sessionId.startsWith('thread_')) {
      throw new Error(
        'INCOMPATIBLE_SESSION_ID: This session was created with a different coding agent and cannot be resumed with Codex.'
      )
    }

    const abortController = new AbortController()

    // Spawn new codex process
    const codexProcess = spawn(
      this.codexExecutablePath,
      [
        '--model',
        config.model || 'gpt-5.3-codex',
        '--json-rpc',
      ],
      {
        cwd: config.workspaceDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.buildCodexEnvironment(),
      }
    )

    // Create session state
    const session: CodexSession = {
      threadId: sessionId,
      process: codexProcess,
      workspaceDir: config.workspaceDir,
      messageBuffer: [],
      status: 'idle',
      abortController,
      config,
      lastError: null,
      nextRpcId: 1,
      pendingRpcCalls: new Map(),
      stdoutBuffer: '',
    }

    // Set up stdout parser
    this.setupStdoutParser(codexProcess, session)

    // Set up stderr logging
    codexProcess.stderr?.on('data', (chunk: Buffer) => {
      console.error('[CodexAdapter] Codex stderr:', chunk.toString())
    })

    // Handle process exit
    codexProcess.on('exit', (code, signal) => {
      console.log(`[CodexAdapter] Codex process exited: code=${code}, signal=${signal}`)
      if (code !== 0 && code !== null) {
        session.status = 'error'
        session.lastError = `Codex process exited with code ${code}`
      }
    })

    try {
      // Initialize JSON-RPC session
      const apiKey = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY
      await this.sendRpcRequest(session, 'initialize', {
        api_key: apiKey,
        model: config.model || 'gpt-5.3-codex',
      })

      // Fetch thread history
      const historyResponse = (await this.sendRpcRequest(session, 'thread.messages', {
        thread_id: sessionId,
      })) as {
        messages: Array<{
          id: string
          role: 'user' | 'assistant' | 'system'
          content: string
          created_at: number
        }>
      }

      // Store session
      this.sessions.set(sessionId, session)

      // Convert history to SessionMessage format
      const messages: SessionMessage[] = historyResponse.messages.map((msg) => ({
        id: msg.id,
        role: msg.role === 'user' ? MessageRole.USER : MessageRole.ASSISTANT,
        parts: [
          {
            id: `${msg.id}-text`,
            type: MessagePartType.TEXT,
            text: msg.content,
          },
        ],
      }))

      console.log(`[CodexAdapter] Resumed session ${sessionId} with ${messages.length} messages`)
      return messages
    } catch (error: any) {
      // Check if thread not found
      if (error.message?.includes('thread not found') || error.message?.includes('Thread not found')) {
        codexProcess.kill()
        throw new Error(
          'INCOMPATIBLE_SESSION_ID: This session does not exist on Codex servers. It may have been created with a different coding agent or has expired.'
        )
      }

      // Cleanup on error
      codexProcess.kill()
      throw error
    }
  }

  async sendPrompt(
    sessionId: string,
    parts: MessagePart[],
    _config: SessionConfig
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // Extract text from parts
    const promptText = parts
      .filter((p) => p.type === MessagePartType.TEXT && p.text)
      .map((p) => p.text!)
      .join('\n')

    if (!promptText) {
      throw new Error('No text content in prompt parts')
    }

    // Add user message to buffer
    const userMessage: CodexMessage = {
      type: 'text',
      id: `user-${Date.now()}`,
      role: 'user',
      content: promptText,
    }
    session.messageBuffer.push(userMessage)

    session.status = 'busy'

    try {
      // Send message via JSON-RPC
      await this.sendRpcRequest(session, 'message.create', {
        thread_id: session.threadId,
        role: 'user',
        content: promptText,
      })

      console.log(`[CodexAdapter] Sent prompt to thread ${session.threadId}`)
    } catch (error: any) {
      session.status = 'error'
      session.lastError = error.message
      throw error
    }
  }

  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { type: SessionStatusType.ERROR, message: 'Session not found' }
    }

    if (session.lastError) {
      return { type: SessionStatusType.ERROR, message: session.lastError }
    }

    return {
      type: session.status === 'busy' ? SessionStatusType.BUSY : SessionStatusType.IDLE,
    }
  }

  async pollMessages(
    sessionId: string,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    _config: SessionConfig
  ): Promise<MessagePart[]> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return []
    }

    const newParts: MessagePart[] = []

    // Process buffered messages
    for (const codexMsg of session.messageBuffer) {
      if (seenMessageIds.has(codexMsg.id)) continue
      seenMessageIds.add(codexMsg.id)

      // Convert CodexMessage to MessagePart
      const parts = this.convertCodexMessageToParts(codexMsg, seenPartIds, partContentLengths)
      newParts.push(...parts)
    }

    // Clear processed messages from buffer
    session.messageBuffer = []

    return newParts
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // Send abort request
    try {
      await this.sendRpcRequest(session, 'message.abort', {
        thread_id: session.threadId,
      })
    } catch (error: any) {
      console.warn(`[CodexAdapter] Failed to abort: ${error.message}`)
    }

    session.status = 'idle'
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }

    // Kill process
    session.process.kill('SIGTERM')

    // Wait a bit, then force kill if needed
    setTimeout(() => {
      if (!session.process.killed) {
        session.process.kill('SIGKILL')
      }
    }, 1000)

    // Remove session
    this.sessions.delete(sessionId)
  }

  async registerMcpServer(
    _serverName: string,
    _mcpConfig: {
      type: 'local' | 'remote'
      command?: string[]
      args?: string[]
      url?: string
      headers?: Record<string, string>
      environment?: Record<string, string>
    },
    _workspaceDir?: string
  ): Promise<void> {
    // Codex doesn't support MCP servers yet
    // This is a no-op for now
    console.warn('[CodexAdapter] MCP servers are not yet supported by Codex')
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      const execPath = await this.findCodexExecutable()
      if (!execPath) {
        return { available: false, reason: 'Codex CLI not found. Install from: https://openai.com/codex' }
      }

      // Check if API key is available
      if (!process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY) {
        return { available: false, reason: 'OPENAI_API_KEY not set in environment' }
      }

      // Verify Codex CLI is executable by checking version
      try {
        const { execFile } = await import('child_process')
        const { promisify } = await import('util')
        const execFileAsync = promisify(execFile)

        await execFileAsync(execPath, ['--version'], { timeout: 5000 })
        return { available: true }
      } catch (error: any) {
        return { available: false, reason: `Codex CLI found but not executable: ${error.message}` }
      }
    } catch (error: any) {
      return { available: false, reason: error.message }
    }
  }


  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  /**
   * Set up stdout parser for JSON-RPC messages
   */
  private setupStdoutParser(process: ChildProcess, session: CodexSession): void {
    process.stdout?.on('data', (chunk: Buffer) => {
      session.stdoutBuffer += chunk.toString()

      // Parse newline-delimited JSON messages
      let newlineIndex: number
      while ((newlineIndex = session.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = session.stdoutBuffer.slice(0, newlineIndex).trim()
        session.stdoutBuffer = session.stdoutBuffer.slice(newlineIndex + 1)

        if (!line) continue

        try {
          const message = JSON.parse(line) as JsonRpcMessage
          this.handleRpcMessage(session, message)
        } catch (error) {
          console.error('[CodexAdapter] Failed to parse JSON-RPC message:', line)
        }
      }
    })
  }

  /**
   * Handle incoming JSON-RPC message
   */
  private handleRpcMessage(session: CodexSession, message: JsonRpcMessage): void {
    // Response to our RPC request
    if ('id' in message && message.id !== undefined) {
      const pending = session.pendingRpcCalls.get(message.id as number)
      if (pending) {
        session.pendingRpcCalls.delete(message.id as number)

        // Type guard for JsonRpcResponse
        const response = message as JsonRpcResponse
        if ('error' in response && response.error) {
          pending.reject(new Error(response.error.message))
        } else if ('result' in response) {
          pending.resolve(response.result)
        } else {
          pending.reject(new Error('Invalid RPC response'))
        }
      }
      return
    }

    // Notification (streaming event)
    if ('method' in message) {
      this.handleNotification(session, message as JsonRpcNotification)
    }
  }

  /**
   * Handle JSON-RPC notification (streaming events)
   */
  private handleNotification(session: CodexSession, notification: JsonRpcNotification): void {
    const params = notification.params as any

    switch (notification.method) {
      case 'message.delta':
        // Text content streaming
        session.messageBuffer.push({
          type: 'text',
          id: params.message_id || `msg-${Date.now()}`,
          role: params.role || 'assistant',
          delta: params.delta?.content || '',
          content: params.delta?.content || '',
        })
        break

      case 'message.completed':
        // Message finished
        session.status = 'idle'
        session.messageBuffer.push({
          type: 'text',
          id: params.message_id || `msg-${Date.now()}`,
          role: 'assistant',
          finished: true,
        } as CodexMessage)
        break

      case 'tool.call':
        // Tool call started
        session.messageBuffer.push({
          type: 'tool_call',
          id: params.tool_call_id || `tool-${Date.now()}`,
          tool_name: params.tool_name,
          tool_call_id: params.tool_call_id,
          arguments: params.arguments,
        })
        break

      case 'tool.result':
        // Tool call completed
        session.messageBuffer.push({
          type: 'tool_result',
          id: params.tool_call_id || `tool-${Date.now()}`,
          tool_call_id: params.tool_call_id,
          result: params.result,
        })
        break

      case 'error':
        // Error occurred
        session.status = 'error'
        session.lastError = params.message || 'Unknown error'
        session.messageBuffer.push({
          type: 'error',
          id: `error-${Date.now()}`,
          error: params.message,
        })
        break

      default:
        console.log(`[CodexAdapter] Unknown notification: ${notification.method}`)
    }
  }

  /**
   * Send JSON-RPC request and wait for response
   */
  private sendRpcRequest(session: CodexSession, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = session.nextRpcId++
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      // Store pending call
      session.pendingRpcCalls.set(id, { resolve, reject })

      // Send request
      const requestJson = JSON.stringify(request) + '\n'
      session.process.stdin?.write(requestJson, (error) => {
        if (error) {
          session.pendingRpcCalls.delete(id)
          reject(error)
        }
      })

      // Timeout after 30 seconds
      setTimeout(() => {
        if (session.pendingRpcCalls.has(id)) {
          session.pendingRpcCalls.delete(id)
          reject(new Error(`RPC request timed out: ${method}`))
        }
      }, 30000)
    })
  }

  /**
   * Convert CodexMessage to MessagePart format
   */
  private convertCodexMessageToParts(
    msg: CodexMessage,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>
  ): MessagePart[] {
    const parts: MessagePart[] = []

    switch (msg.type) {
      case 'text':
        const textPartId = `${msg.id}-text`
        if (!seenPartIds.has(textPartId)) {
          seenPartIds.add(textPartId)
          const content = msg.content || msg.delta || ''
          partContentLengths.set(textPartId, String(content.length))
          parts.push({
            id: textPartId,
            type: MessagePartType.TEXT,
            text: content,
            role: msg.role,
          })
        }
        break

      case 'tool_call':
        const toolCallPartId = `tool-${msg.tool_call_id}`
        if (!seenPartIds.has(toolCallPartId)) {
          seenPartIds.add(toolCallPartId)
          const input = msg.arguments ? JSON.stringify(msg.arguments, null, 2) : undefined
          partContentLengths.set(toolCallPartId, `pending:${msg.tool_name}`)
          parts.push({
            id: toolCallPartId,
            type: MessagePartType.TOOL,
            content: `Tool: ${msg.tool_name}`,
            tool: {
              name: msg.tool_name || 'unknown',
              status: 'pending',
              input,
            },
          })
        }
        break

      case 'tool_result':
        const toolResultPartId = `tool-${msg.tool_call_id}`
        const previousContent = partContentLengths.get(toolResultPartId)
        if (previousContent) {
          // Update existing tool part
          partContentLengths.set(toolResultPartId, `success:${msg.result?.length || 0}`)
          parts.push({
            id: toolResultPartId,
            type: MessagePartType.TOOL,
            content: 'Tool completed',
            tool: {
              name: previousContent.split(':')[1] || 'tool',
              status: 'success',
              output: msg.result?.slice(0, 2000),
            },
            update: true,
          })
        } else {
          // First time seeing this tool (result before call)
          if (!seenPartIds.has(toolResultPartId)) {
            seenPartIds.add(toolResultPartId)
            partContentLengths.set(toolResultPartId, `success:${msg.result?.length || 0}`)
            parts.push({
              id: toolResultPartId,
              type: MessagePartType.TOOL,
              content: 'Tool result',
              tool: {
                name: 'tool',
                status: 'success',
                output: msg.result?.slice(0, 2000),
              },
            })
          }
        }
        break

      case 'error':
        const errorPartId = `${msg.id}-error`
        if (!seenPartIds.has(errorPartId)) {
          seenPartIds.add(errorPartId)
          parts.push({
            id: errorPartId,
            type: MessagePartType.ERROR,
            content: msg.error || 'Unknown error',
          })
        }
        break
    }

    return parts
  }
}
