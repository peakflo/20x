/**
 * Unified ACP (Agent Client Protocol) adapter for all ACP-compatible coding agents.
 * Supports: codex-acp, claude-code-acp, and other ACP-compliant agent processes.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON)
 * Spec: https://github.com/agentclientprotocol/typescript-sdk
 */

import { spawn, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import type {
  CodingAgentAdapter,
  SessionConfig,
  SessionMessage,
  SessionStatus,
  MessagePart,
  McpServerConfig
} from './coding-agent-adapter'
import { SessionStatusType, MessagePartType, MessageRole } from './coding-agent-adapter'

// ACP Agent Types
export type AcpAgentType = 'codex' | 'claude-code'

// ACP Agent Process Configuration
interface AcpAgentConfig {
  command: string  // e.g., 'codex-acp', 'claude-code-acp'
  args: string[]   // Additional arguments
  env?: Record<string, string>  // Environment variables
}

// JSON-RPC 2.0 Types
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

interface JsonRpcError {
  jsonrpc: '2.0'
  id: string | number
  error: {
    code: number
    message: string
    data?: unknown
  }
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse | JsonRpcError

// ACP Session Update Notification
interface SessionUpdate {
  sessionUpdate?: string
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  content?: {
    type?: string
    text?: string
  } | Array<{
    type: string
    content?: {
      type?: string
      text?: string
    }
  }>
  entries?: Array<{
    content: string
    priority: string
    status: string
  }>
}

// ACP Permission Request
interface AcpPermissionRequest {
  requestId: string | number
  toolCallId: string
  question: string
  options: Array<{
    optionId: string
    name: string
    kind: string
  }>
}

// ACP Session State
interface AcpSession {
  sessionId: string  // Our internal session ID
  acpSessionId: string | null  // ACP protocol session ID
  process: ChildProcess
  stdoutBuffer: string
  status: SessionStatusType
  messageBuffer: unknown[]  // Buffered ACP events (cleared after poll)
  permanentMessages: unknown[]  // All messages (never cleared, for getAllMessages)
  pendingRequests: Map<string | number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>
  nextRequestId: number
  pendingApproval: AcpPermissionRequest | null  // Permission request awaiting user response
  promptRequestId: number | null  // ID of the current session/prompt request
  responseCounter: number  // Counter for unique message IDs per response turn
  lastChunkTime: number | null  // Timestamp of last agent_message_chunk
  currentTurnId: number  // Auto-incremented ID for each detected response turn
  sawToolCallSinceLastChunk: boolean  // Whether we saw a tool_call since last chunk
}

/**
 * Unified ACP adapter for all ACP-compatible agents
 */
export class AcpAdapter implements CodingAgentAdapter {
  private agentType: AcpAgentType
  private agentConfig: AcpAgentConfig
  private sessions = new Map<string, AcpSession>()

  constructor(agentType: AcpAgentType) {
    this.agentType = agentType
    this.agentConfig = this.getAgentConfig(agentType)
  }

  private getAgentConfig(agentType: AcpAgentType): AcpAgentConfig {
    switch (agentType) {
      case 'codex':
        // codex-acp is a Node.js script, so we need to run it via node
        return {
          command: 'node',
          args: [require.resolve('@zed-industries/codex-acp/bin/codex-acp.js')],
          env: {
            // Codex requires OPENAI_API_KEY or CODEX_API_KEY
            ...(process.env.OPENAI_API_KEY && { OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
            ...(process.env.CODEX_API_KEY && { CODEX_API_KEY: process.env.CODEX_API_KEY })
          }
        }
      case 'claude-code':
        // claude-code-acp is also a Node.js script
        return {
          command: 'node',
          args: [require.resolve('@zed-industries/claude-code-acp/dist/index.js')],
          env: {
            // Claude Code requires ANTHROPIC_API_KEY
            ...(process.env.ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY })
          }
        }
      default:
        throw new Error(`Unsupported ACP agent type: ${agentType}`)
    }
  }

  async initialize(): Promise<void> {
    // Verify agent process is available
    const health = await this.checkHealth()
    if (!health.available) {
      throw new Error(health.reason || 'ACP agent not available')
    }
    console.log(`[AcpAdapter/${this.agentType}] Initialized successfully`)
  }

  /**
   * Authenticate the session if required
   * Note: claude-code-acp doesn't implement authenticate - it uses env vars
   */
  private async authenticateSession(session: AcpSession, initResult: unknown): Promise<void> {
    const initObj = initResult as Record<string, unknown> | undefined
    const authMethods = (Array.isArray(initObj?.authMethods) ? initObj.authMethods : []) as Array<{ id: string; [key: string]: unknown }>

    if (authMethods.length > 0 && this.agentType !== 'claude-code') {
      // Prefer API key auth methods (they read from environment)
      const authMethod = authMethods.find((m) =>
        m.id === 'openai-api-key' || m.id === 'codex-api-key'
      ) || authMethods[0]

      console.log(`[AcpAdapter/${this.agentType}] Authenticating with method: ${authMethod.id}`)

      await this.sendRpcRequest(session, 'authenticate', {
        methodId: authMethod.id
      })
    } else if (this.agentType === 'claude-code') {
      console.log(`[AcpAdapter/${this.agentType}] Skipping authenticate (uses env vars)`)
    }
  }

  async createSession(config: SessionConfig): Promise<string> {
    const sessionId = config.taskId

    console.log(`[AcpAdapter/${this.agentType}] Creating session ${sessionId}`)

    // Prepare environment with API keys
    const env = {
      ...process.env,
      ...this.agentConfig.env
    }

    // Override with configured API keys if provided
    if (config.apiKeys?.openai) {
      env.OPENAI_API_KEY = config.apiKeys.openai
      env.CODEX_API_KEY = config.apiKeys.openai
    }
    if (config.apiKeys?.anthropic) {
      env.ANTHROPIC_API_KEY = config.apiKeys.anthropic
    }

    // Inject secret env vars directly into process environment
    if (config.secretEnvVars && Object.keys(config.secretEnvVars).length > 0) {
      for (const [key, value] of Object.entries(config.secretEnvVars)) {
        env[key] = value
      }
    }

    // Log warnings if API keys are missing (agents may have their own auth)
    if (this.agentType === 'codex') {
      if (!env.OPENAI_API_KEY && !env.CODEX_API_KEY) {
        console.warn('[AcpAdapter/codex] No OPENAI_API_KEY or CODEX_API_KEY in environment — relying on agent\'s own auth')
      }
    } else if (this.agentType === 'claude-code') {
      if (!env.ANTHROPIC_API_KEY) {
        console.warn('[AcpAdapter/claude-code] No ANTHROPIC_API_KEY in environment — relying on agent\'s own auth')
      }
    }

    // Spawn ACP agent process
    const acpProcess = spawn(
      this.agentConfig.command,
      this.agentConfig.args,
      {
        cwd: config.workspaceDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )

    const session: AcpSession = {
      sessionId,
      acpSessionId: null,
      process: acpProcess,
      stdoutBuffer: '',
      status: SessionStatusType.IDLE,
      messageBuffer: [],
      permanentMessages: [],
      pendingRequests: new Map(),
      nextRequestId: 1,
      pendingApproval: null,
      promptRequestId: null,
      responseCounter: 0,
      lastChunkTime: null,
      currentTurnId: 0,
      sawToolCallSinceLastChunk: false
    }

    // Temporarily store with workspace ID, will re-key after getting ACP session ID
    this.sessions.set(sessionId, session)

    // Set up stdout parser
    this.setupStdoutParser(acpProcess, session)

    // Set up stderr logging
    acpProcess.stderr?.on('data', (chunk: Buffer) => {
      console.log(`[AcpAdapter/${this.agentType}] stderr:`, chunk.toString())
    })

    // Handle process exit
    acpProcess.on('exit', (code, signal) => {
      console.log(`[AcpAdapter/${this.agentType}] Process exited: code=${code}, signal=${signal}`)
      session.status = code === 0 ? SessionStatusType.IDLE : SessionStatusType.ERROR
    })

    // Initialize ACP protocol
    const initResult = await this.sendRpcRequest(session, 'initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'pf-desktop',
        version: '0.0.1'
      }
    })

    // Authenticate if required
    await this.authenticateSession(session, initResult)

    // Create ACP session (only accepts cwd and mcpServers per ACP spec)
    const convertedMcpServers = this.convertMcpServers(config.mcpServers) || []
    console.log(`[AcpAdapter/${this.agentType}] session/new mcpServers:`, JSON.stringify(convertedMcpServers))
    const result = await this.sendRpcRequest(session, 'session/new', {
      cwd: config.workspaceDir,
      mcpServers: convertedMcpServers
    })

    // Extract session ID from result
    const acpSessionId = this.extractAcpSessionId(result)
    if (acpSessionId) {
      session.acpSessionId = acpSessionId
      // Re-key the session map with the ACP session ID
      this.sessions.delete(sessionId)
      this.sessions.set(acpSessionId, session)
    }

    // Set model if specified
    if (config.model && acpSessionId) {
      try {
        await this.sendRpcRequest(session, 'session/set_config_option', {
          sessionId: acpSessionId,
          configId: 'model',
          value: config.model
        })
        console.log(`[AcpAdapter/${this.agentType}] Model set to: ${config.model}`)
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error)
        console.warn(`[AcpAdapter/${this.agentType}] Failed to set model: ${errMsg}`)
        // Continue even if model setting fails (agent will use default)
      }
    }

    console.log(`[AcpAdapter/${this.agentType}] Session created: ${sessionId} (ACP: ${acpSessionId})`)

    // Return the ACP session ID so it can be persisted and used for resuming
    return acpSessionId || sessionId
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    console.log(`[AcpAdapter/${this.agentType}] Resuming session ${sessionId}`)
    console.log(`[AcpAdapter/${this.agentType}] Config API keys:`, {
      hasApiKeys: !!config.apiKeys,
      hasOpenai: !!config.apiKeys?.openai,
      hasAnthropic: !!config.apiKeys?.anthropic,
      anthropicKeyLength: config.apiKeys?.anthropic?.length
    })

    // Prepare environment with API keys
    const env = {
      ...process.env,
      ...this.agentConfig.env
    }

    // Override with configured API keys if provided
    if (config.apiKeys?.openai) {
      env.OPENAI_API_KEY = config.apiKeys.openai
      env.CODEX_API_KEY = config.apiKeys.openai
    }
    if (config.apiKeys?.anthropic) {
      env.ANTHROPIC_API_KEY = config.apiKeys.anthropic
    }

    console.log(`[AcpAdapter/${this.agentType}] Environment after config:`, {
      hasAnthropicInEnv: !!env.ANTHROPIC_API_KEY,
      anthropicKeyLength: env.ANTHROPIC_API_KEY?.length,
      anthropicKeyPrefix: env.ANTHROPIC_API_KEY?.substring(0, 5)
    })

    // Inject secret env vars directly into process environment
    if (config.secretEnvVars && Object.keys(config.secretEnvVars).length > 0) {
      for (const [key, value] of Object.entries(config.secretEnvVars)) {
        env[key] = value
      }
    }

    // Log warnings if API keys are missing (agents may have their own auth)
    if (this.agentType === 'codex') {
      if (!env.OPENAI_API_KEY && !env.CODEX_API_KEY) {
        console.warn('[AcpAdapter/codex] No OPENAI_API_KEY or CODEX_API_KEY in environment — relying on agent\'s own auth')
      }
    } else if (this.agentType === 'claude-code') {
      if (!env.ANTHROPIC_API_KEY) {
        console.warn('[AcpAdapter/claude-code] No ANTHROPIC_API_KEY in environment — relying on agent\'s own auth')
      }
    }

    // Spawn ACP agent process
    const acpProcess = spawn(
      this.agentConfig.command,
      this.agentConfig.args,
      {
        cwd: config.workspaceDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )

    const session: AcpSession = {
      sessionId,
      acpSessionId: sessionId, // sessionId is now the Codex UUID from database
      process: acpProcess,
      stdoutBuffer: '',
      status: SessionStatusType.IDLE,
      messageBuffer: [],
      permanentMessages: [],
      pendingRequests: new Map(),
      nextRequestId: 1,
      pendingApproval: null,
      promptRequestId: null,
      responseCounter: 0,
      lastChunkTime: null,
      currentTurnId: 0,
      sawToolCallSinceLastChunk: false
    }

    // Store with the Codex UUID (same as sessionId since we now return UUID from createSession)
    this.sessions.set(sessionId, session)

    // Set up stdout parser
    this.setupStdoutParser(acpProcess, session)

    // Set up stderr logging
    acpProcess.stderr?.on('data', (chunk: Buffer) => {
      console.log(`[AcpAdapter/${this.agentType}] stderr:`, chunk.toString())
    })

    // Handle process exit
    acpProcess.on('exit', (code, signal) => {
      console.log(`[AcpAdapter/${this.agentType}] Process exited: code=${code}, signal=${signal}`)
      session.status = code === 0 ? SessionStatusType.IDLE : SessionStatusType.ERROR
    })

    // Initialize ACP protocol
    const initResult = await this.sendRpcRequest(session, 'initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'pf-desktop',
        version: '0.0.1'
      }
    })

    // Authenticate if required
    await this.authenticateSession(session, initResult)

    // Try to load existing session
    try {
      await this.sendRpcRequest(session, 'session/load', {
        sessionId: sessionId,
        cwd: config.workspaceDir,
        mcpServers: this.convertMcpServers(config.mcpServers) || []
      })

      console.log(`[AcpAdapter/${this.agentType}] Session loaded successfully: ${sessionId}`)

      // TODO: Extract and return session messages from session/update notifications
      // For now, return empty array - messages will be replayed via notifications
      return []
    } catch (error: unknown) {
      // Check if session not found
      const errMsg = error instanceof Error ? error.message : String(error)
      if (errMsg.includes('not found') || errMsg.includes('does not exist')) {
        // Clean up process
        acpProcess.kill('SIGTERM')
        this.sessions.delete(sessionId)

        throw new Error(
          `INCOMPATIBLE_SESSION_ID: This ${this.agentType} session does not exist or has expired. Please start a new session.`
        )
      }

      // Re-throw other errors
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

    // Extract text from message parts
    const promptText = parts
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text)
      .join('\n')

    if (!promptText) {
      throw new Error('No text content in message parts')
    }

    console.log(`[AcpAdapter/${this.agentType}] Sending prompt to session ${sessionId}:`)
    console.log(promptText.slice(0, 200) + (promptText.length > 200 ? '...' : ''))

    session.status = SessionStatusType.BUSY

    // Send prompt via ACP (prompt must be an array of ContentBlock objects)
    // Note: session/prompt is a long-running operation that responds via session/update notifications
    // We send the request but don't await the response to avoid timeout
    this.sendRpcRequestNoWait(session, 'session/prompt', {
      sessionId: session.acpSessionId,
      prompt: [
        {
          type: 'text',
          text: promptText
        }
      ]
    })
  }

  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { type: SessionStatusType.ERROR, message: 'Session not found' }
    }

    return {
      type: session.status,
      message: session.status === 'error' ? 'Process error' : undefined
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

    // Process buffered ACP events
    for (const event of session.messageBuffer) {
      const converted = this.convertAcpEventToMessageParts(event, seenMessageIds, seenPartIds, partContentLengths, session)
      newParts.push(...converted)
    }

    // Clear processed events
    session.messageBuffer = []

    return newParts
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    console.log(`[AcpAdapter/${this.agentType}] Sending session/cancel for ${sessionId}`)

    // Send session/cancel notification (not a request - no response expected)
    this.sendRpcNotification(session, 'session/cancel', {
      sessionId: session.acpSessionId
    })

    // The agent will respond to the original session/prompt with stopReason: cancelled
    // Status will be updated when we receive that response
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }

    console.log(`[AcpAdapter/${this.agentType}] Destroying session ${sessionId}`)

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

  async getAllMessages(sessionId: string, _config: SessionConfig): Promise<SessionMessage[]> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return []
    }

    // Convert all permanent messages to SessionMessages
    const seenMessageIds = new Set<string>()
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    // Use a Map to keep only the latest version of each part (by ID)
    const partsByIdAndRole = new Map<string, MessagePart>()

    // Process all permanent messages
    for (const event of session.permanentMessages) {
      const parts = this.convertAcpEventToMessageParts(
        event,
        seenMessageIds,
        seenPartIds,
        partContentLengths,
        session
      )

      // Keep only latest version of each part
      for (const part of parts) {
        const key = `${part.id}-${part.role || 'assistant'}`
        // Only keep if newer or doesn't exist
        if (!partsByIdAndRole.has(key) || part.update) {
          partsByIdAndRole.set(key, part)
        }
      }
    }

    const allParts = Array.from(partsByIdAndRole.values())

    // Convert MessageParts to SessionMessages
    const messages: SessionMessage[] = []

    // Group parts by role to create messages
    let currentMessage: SessionMessage | null = null
    let messageIdCounter = 0

    for (const part of allParts) {
      const roleStr = part.role || 'assistant'
      const role = roleStr === 'user' ? MessageRole.USER :
                   roleStr === 'system' ? MessageRole.SYSTEM :
                   MessageRole.ASSISTANT

      // Start new message if role changed or no current message
      if (!currentMessage || currentMessage.role !== role) {
        if (currentMessage) {
          messages.push(currentMessage)
        }
        currentMessage = {
          id: `msg-${messageIdCounter++}`,
          role,
          parts: []
        }
      }

      currentMessage!.parts.push(part)
    }

    // Push last message
    if (currentMessage) {
      messages.push(currentMessage)
    }

    return messages
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
    // MCP server registration is handled during session creation
    console.log(`[AcpAdapter/${this.agentType}] MCP server registration deferred to session creation`)
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      // Verify the ACP agent package is installed
      const packageName = this.agentType === 'codex'
        ? '@zed-industries/codex-acp'
        : '@zed-industries/claude-code-acp'

      try {
        // Different packages have different entry points
        const entryPoint = this.agentType === 'codex'
          ? `${packageName}/bin/codex-acp.js`
          : `${packageName}/dist/index.js`
        require.resolve(entryPoint)
      } catch {
        return {
          available: false,
          reason: `${packageName} not found. Install with: pnpm add ${packageName}`
        }
      }

      // Note: We don't check API keys here because they can be provided
      // via UI configuration (agent.config.api_keys) at session creation time

      return { available: true }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return { available: false, reason: errMsg }
    }
  }

  /**
   * Get pending approval request for a session
   */
  getPendingApproval(sessionId: string): AcpPermissionRequest | null {
    const session = this.sessions.get(sessionId)
    return session?.pendingApproval || null
  }

  /**
   * Respond to a pending approval request
   */
  async respondToApproval(
    sessionId: string,
    approved: boolean,
    optionId?: string
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.pendingApproval) {
      console.warn(`[AcpAdapter/${this.agentType}] No pending approval for session ${sessionId}`)
      return
    }

    const approval = session.pendingApproval

    // Determine the outcome based on user choice
    let selectedOptionId = optionId
    if (!selectedOptionId) {
      // If no specific option, use approved/abort
      selectedOptionId = approved ? 'approved' : 'abort'
    }

    console.log(`[AcpAdapter/${this.agentType}] Responding to approval with: ${selectedOptionId}`)

    // Send response to agent with correct ACP format
    // Based on TypeScript SDK: outcome has double nesting with outcome field
    this.sendRpcResponse(session, approval.requestId, {
      result: {
        outcome: {
          outcome: 'selected',
          optionId: selectedOptionId
        }
      }
    })

    // Clear pending approval
    session.pendingApproval = null
  }


  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  private setupStdoutParser(process: ChildProcess, session: AcpSession): void {
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
          console.error(`[AcpAdapter/${this.agentType}] Failed to parse JSON-RPC message:`, line, error)
        }
      }
    })
  }

  private handleRpcMessage(session: AcpSession, message: JsonRpcMessage): void {
    console.log(`[AcpAdapter/${this.agentType}] Received RPC message:`, JSON.stringify(message))

    // Handle responses to our requests
    if ('id' in message && message.id !== undefined && !('method' in message)) {
      const pending = session.pendingRequests.get(message.id)
      if (pending) {
        session.pendingRequests.delete(message.id)

        const response = message as JsonRpcResponse | JsonRpcError
        if ('error' in response && response.error) {
          pending.reject(new Error(response.error.message))
        } else if ('result' in response) {
          pending.resolve(response.result)
        }
        return
      }

      // No pending request - could be error for permission response or other async operation
      const response = message as JsonRpcResponse | JsonRpcError
      if ('error' in response && response.error) {
        console.error(`[AcpAdapter/${this.agentType}] Unexpected error response:`, response.error)
        // Push error to message buffers
        const errorEvent = {
          _isError: true,
          message: response.error.message,
          data: response.error.data
        }
        session.messageBuffer.push(errorEvent)
        session.permanentMessages.push(errorEvent)
        return
      }

      // Check if this is a response to session/prompt
      if (session.promptRequestId === message.id && 'result' in response) {
        const result = response.result as Record<string, unknown> | undefined
        if (result?.stopReason) {
          console.log(`[AcpAdapter/${this.agentType}] Prompt completed with stopReason: ${result.stopReason}`)
          session.status = SessionStatusType.IDLE
          // Don't clear promptRequestId - keep it for late-arriving events
          // It will be updated when the next prompt is sent
        }
        return
      }
    }

    // Handle requests from agent (e.g., session/request_permission)
    if ('method' in message && 'id' in message && message.id !== undefined) {
      const request = message as JsonRpcRequest
      console.log(`[AcpAdapter/${this.agentType}] << Request: ${request.method}`)

      if (request.method === 'session/request_permission') {
        this.handlePermissionRequest(session, request)
        return
      }

      // Unknown request - send error response
      this.sendRpcResponse(session, request.id, {
        error: { code: -32601, message: `Method not found: ${request.method}` }
      })
      return
    }

    // Handle notifications from agent
    if ('method' in message && !('id' in message)) {
      const notification = message as JsonRpcNotification

      console.log(`[AcpAdapter/${this.agentType}] << Notification: ${notification.method}`)
      if (notification.method === 'session/update') {
        const params = notification.params as { update?: SessionUpdate } | undefined
        console.log(`[AcpAdapter/${this.agentType}]    sessionUpdate: ${params?.update?.sessionUpdate}`)
      }

      // Store notification directly (no wrapping needed)
      // Turn detection happens automatically based on time gaps and tool calls
      // Buffer notification for polling (gets cleared after each poll)
      session.messageBuffer.push(notification)
      // Also store permanently for getAllMessages (never cleared)
      session.permanentMessages.push(notification)

      // Update session status based on notification
      this.updateSessionStatus(session, notification)
    }
  }

  private updateSessionStatus(session: AcpSession, notification: JsonRpcNotification): void {
    // Handle session/update notifications
    if (notification.method === 'session/update') {
      const params = notification.params as { update?: SessionUpdate }
      const update = params?.update

      if (!update) return

      // Update status based on update type
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        session.status = SessionStatusType.BUSY
      } else if (update.sessionUpdate === 'error' || update.sessionUpdate === 'failed') {
        session.status = SessionStatusType.ERROR
      } else if (update.sessionUpdate === 'completed' || update.sessionUpdate === 'finished') {
        session.status = SessionStatusType.IDLE
      }
      // For 'available_commands_update' and other notifications, keep current status
    }
    // Legacy: Handle other notification types by method name
    else if (notification.method.includes('completed') || notification.method.includes('finished')) {
      session.status = SessionStatusType.IDLE
    } else if (notification.method.includes('error') || notification.method.includes('failed')) {
      session.status = SessionStatusType.ERROR
    } else if (notification.method.includes('started') || notification.method.includes('working')) {
      session.status = SessionStatusType.BUSY
    }
  }

  private async sendRpcRequest(
    session: AcpSession,
    method: string,
    params?: unknown
  ): Promise<unknown> {
    const id = session.nextRequestId++

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    }

    return new Promise((resolve, reject) => {
      // Register pending request
      session.pendingRequests.set(id, { resolve, reject })

      // Send request
      const jsonString = JSON.stringify(request) + '\n'
      session.process.stdin?.write(jsonString, (error) => {
        if (error) {
          session.pendingRequests.delete(id)
          reject(new Error(`Failed to send request: ${error.message}`))
        }
      })

      // Timeout after 30 seconds
      setTimeout(() => {
        if (session.pendingRequests.has(id)) {
          session.pendingRequests.delete(id)
          reject(new Error(`Request timeout: ${method}`))
        }
      }, 30000)
    })
  }

  private sendRpcRequestNoWait(
    session: AcpSession,
    method: string,
    params?: unknown
  ): void {
    const id = session.nextRequestId++

    // Track session/prompt request ID so we can handle the response
    if (method === 'session/prompt') {
      session.promptRequestId = id
    }

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    }

    // Send request without waiting for response
    // The response will be handled in handleRpcMessage when it arrives
    const jsonString = JSON.stringify(request) + '\n'
    session.process.stdin?.write(jsonString, (error) => {
      if (error) {
        console.error(`[AcpAdapter/${this.agentType}] Error sending ${method}:`, error)
      }
    })
  }

  private sendRpcResponse(
    session: AcpSession,
    id: string | number,
    response: { result?: unknown; error?: { code: number; message: string; data?: unknown } }
  ): void {
    const rpcResponse: JsonRpcResponse | JsonRpcError = {
      jsonrpc: '2.0',
      id,
      ...(response.error ? { error: response.error } : { result: response.result })
    } as JsonRpcResponse | JsonRpcError

    const jsonString = JSON.stringify(rpcResponse) + '\n'
    console.log(`[AcpAdapter/${this.agentType}] Sending RPC response:`, jsonString.trim())
    session.process.stdin?.write(jsonString, (error) => {
      if (error) console.error(`[AcpAdapter/${this.agentType}] Error sending response:`, error)
    })
  }

  private sendRpcNotification(
    session: AcpSession,
    method: string,
    params?: unknown
  ): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params
    }

    const jsonString = JSON.stringify(notification) + '\n'
    session.process.stdin?.write(jsonString, (error) => {
      if (error) console.error(`[AcpAdapter/${this.agentType}] Error sending notification ${method}:`, error)
    })
  }

  private handlePermissionRequest(session: AcpSession, request: JsonRpcRequest): void {
    const params = request.params as {
      toolCall?: {
        rawInput?: { reason?: string }
        content?: Array<{ content?: { text?: string } }>
        title?: string
        kind?: string
        toolCallId?: string
      }
      options?: Array<{ optionId: string; name: string; kind: string }>
    } | undefined

    // Extract permission details
    const toolCall = params?.toolCall
    const options = params?.options || []

    // Get the question/reason from the tool call
    const question = toolCall?.rawInput?.reason ||
                     toolCall?.content?.[0]?.content?.text ||
                     `Execute: ${toolCall?.title || 'unknown command'}`

    console.log(`[AcpAdapter/${this.agentType}] Permission request:`)
    console.log(`  Question: ${question}`)
    console.log(`  Tool: ${toolCall?.kind} - ${toolCall?.toolCallId}`)
    console.log(`  Options: ${options.map((o) => `${o.name} (${o.optionId})`).join(', ')}`)

    // Store the permission request for UI to handle
    session.pendingApproval = {
      requestId: request.id,
      toolCallId: toolCall?.toolCallId || '',
      question,
      options: options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind
      }))
    }

    // Update session status to waiting for approval
    session.status = SessionStatusType.BUSY

    console.log(`[AcpAdapter/${this.agentType}] Awaiting user approval...`)
  }

  private extractAcpSessionId(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null

    // Try common session ID field names
    const obj = result as Record<string, unknown>
    return (obj.sessionId || obj.session_id || obj.id) as string | null
  }

  private convertMcpServers(servers?: Record<string, McpServerConfig>): unknown[] {
    if (!servers) return []

    return Object.entries(servers).map(([name, config]) => {
      // Only include fields relevant to the server type to avoid
      // deserialization failures with untagged enums (e.g. Codex/Rust)
      if (config.type === 'stdio') {
        return {
          name,
          type: 'stdio',
          command: config.command,
          args: config.args,
          ...(config.env ? { env: config.env } : {})
        }
      } else {
        // http or sse
        return {
          name,
          type: config.type,
          url: config.url,
          ...(config.headers ? { headers: config.headers } : {})
        }
      }
    })
  }

  private convertAcpEventToMessageParts(
    event: unknown,
    _seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    session?: AcpSession
  ): MessagePart[] {
    const parts: MessagePart[] = []

    // Unwrap event (events may be wrapped with metadata)
    const wrappedEvent = event as Record<string, unknown>
    const actualEvent = (wrappedEvent._notification || event) as Record<string, unknown>

    // Handle error events from adapter
    if (actualEvent._isError) {
      const errorId = `error-${Date.now()}`
      if (!seenPartIds.has(errorId)) {
        seenPartIds.add(errorId)
        parts.push({
          id: errorId,
          type: MessagePartType.TEXT,
          text: `Error: ${actualEvent.message}${actualEvent.data ? ` - ${actualEvent.data}` : ''}`,
          role: 'assistant'
        })
      }
      return parts
    }

    const notification = actualEvent as unknown as JsonRpcNotification

    // Handle session/update notifications (primary ACP notification type)
    if (notification.method === 'session/update') {
      const params = notification.params as { update?: SessionUpdate }
      const update = params?.update

      if (!update) return []

      // Use toolCallId as unique identifier for tool calls
      const partId = update.toolCallId || randomUUID()

      // Handle different update types
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        // Mark that we saw a tool call - this helps detect new turns
        if (session) {
          session.sawToolCallSinceLastChunk = true
        }

        // Only create part if it's completed (has output)
        if (update.status === 'completed' && !seenPartIds.has(partId)) {
          seenPartIds.add(partId)

          // Extract command and output from rawInput/rawOutput
          const rawInput = update.rawInput as { command?: string | string[]; parsed_cmd?: Array<{ cmd?: string }> } | undefined
          const rawOutput = update.rawOutput as {
            command?: string | string[];
            stdout?: string;
            stderr?: string;
            formatted_output?: string
          } | undefined

          // Try to get command from multiple sources (tool_call has rawInput, tool_call_update has it in rawOutput)
          const commandFromInput = Array.isArray(rawInput?.command)
            ? rawInput.command.join(' ')
            : rawInput?.command
          const commandFromOutput = Array.isArray(rawOutput?.command)
            ? rawOutput.command.join(' ')
            : rawOutput?.command
          const commandFromParsed = rawInput?.parsed_cmd?.map((c) => c.cmd).join('; ')

          const command = commandFromInput || commandFromOutput || commandFromParsed || update.title || 'Unknown'
          const output = rawOutput?.formatted_output || rawOutput?.stdout || rawOutput?.stderr || ''

          parts.push({
            id: partId,
            type: MessagePartType.TOOL,
            tool: {
              name: update.kind || 'tool',
              status: update.status,
              input: command,
              output: output
            }
          })
        }
      } else if (update.sessionUpdate === 'agent_message_chunk') {
        // Handle streaming text response from agent
        // Format: { content: { type: 'text', text: '...' } }

        // Auto-detect new response turns based on time gaps or tool calls
        const now = Date.now()
        const TIME_GAP_THRESHOLD = 2000 // 2 seconds

        if (session) {
          const timeSinceLastChunk = session.lastChunkTime ? now - session.lastChunkTime : Infinity
          const isNewTurn = session.lastChunkTime === null ||
                           timeSinceLastChunk > TIME_GAP_THRESHOLD ||
                           session.sawToolCallSinceLastChunk

          if (isNewTurn) {
            session.currentTurnId++
            session.sawToolCallSinceLastChunk = false
            console.log(`[AcpAdapter] Detected NEW turn #${session.currentTurnId} (gap: ${timeSinceLastChunk}ms, sawTool: ${session.sawToolCallSinceLastChunk})`)
          }

          session.lastChunkTime = now
        }

        // Use auto-detected turn ID instead of promptRequestId
        const turnId = session?.currentTurnId || 0
        const messageId = turnId > 0 ? `agent-response-${turnId}` : 'agent-response'
        console.log(`[AcpAdapter] agent_message_chunk: turnId=${turnId}, messageId=${messageId}`)

        const content = update.content as { type?: string; text?: string } | undefined
        const chunk = content?.text || ''

        if (chunk) {
          // Accumulate text across multiple chunks
          const currentText = partContentLengths.get(messageId) || ''
          const newText = currentText + chunk
          partContentLengths.set(messageId, newText)

          // Return update part with accumulated text
          parts.push({
            id: messageId,
            type: MessagePartType.TEXT,
            text: newText,
            role: 'assistant',
            update: seenPartIds.has(messageId) // Mark as update if we've seen this ID before
          })

          seenPartIds.add(messageId)
        }
      } else if (update.sessionUpdate === 'agent_thought_chunk') {
        // Handle reasoning/thinking chunks
        // Format: { content: { type: 'text', text: '...' } }
        // Use auto-detected turn ID
        const turnId = session?.currentTurnId || 0
        const thinkingId = turnId > 0 ? `agent-thinking-${turnId}` : 'agent-thinking'
        const content = update.content as { type?: string; text?: string } | undefined
        const chunk = content?.text || ''

        if (chunk) {
          // Accumulate text across multiple chunks
          const currentText = partContentLengths.get(thinkingId) || ''
          const newText = currentText + chunk
          partContentLengths.set(thinkingId, newText)

          // Return update part with accumulated text
          parts.push({
            id: thinkingId,
            type: MessagePartType.REASONING,
            text: newText,
            role: 'assistant',
            update: seenPartIds.has(thinkingId)
          })

          seenPartIds.add(thinkingId)
        }
      } else if (update.sessionUpdate === 'user_message_chunk') {
        // Handle streaming user message chunks (usually when user types)
        const userId = 'user-message'
        const content = update.content as { type?: string; text?: string } | undefined
        const chunk = content?.text || ''

        if (chunk) {
          // Accumulate text across multiple chunks
          const currentText = partContentLengths.get(userId) || ''
          const newText = currentText + chunk
          partContentLengths.set(userId, newText)

          // Return update part with accumulated text
          parts.push({
            id: userId,
            type: MessagePartType.TEXT,
            text: newText,
            role: 'user',
            update: seenPartIds.has(userId)
          })

          seenPartIds.add(userId)
        }
      } else if (update.sessionUpdate === 'plan') {
        // Handle agent plan - we can ignore this for now or display it later
        // Format: { entries: [{ content: '...', priority: 'high', status: 'pending' }] }
        console.log(`[AcpAdapter/${this.agentType}] Received plan with ${(update.entries || []).length} entries`)
      }
    }

    return parts
  }
}
