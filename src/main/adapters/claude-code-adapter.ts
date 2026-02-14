/**
 * Claude Code Adapter
 *
 * Implements CodingAgentAdapter for Claude Code using @anthropic-ai/claude-agent-sdk.
 *
 * Key differences from OpenCode:
 * - Uses AsyncGenerator streaming API instead of HTTP client
 * - File-based session persistence (~/.claude/sessions/)
 * - Different message format (SDKMessage vs OpenCode messages)
 */

import type {
  CodingAgentAdapter,
  SessionConfig,
  SessionStatus,
  SessionMessage,
  MessagePart,
} from './coding-agent-adapter'
import { SessionStatusType, MessagePartType } from './coding-agent-adapter'

type ClaudeSDK = typeof import('@anthropic-ai/claude-agent-sdk')
type Query = import('@anthropic-ai/claude-agent-sdk').Query
type SDKMessage = import('@anthropic-ai/claude-agent-sdk').SDKMessage
type Options = import('@anthropic-ai/claude-agent-sdk').Options
type McpServerConfig = import('@anthropic-ai/claude-agent-sdk').McpServerConfig

let ClaudeAgentSDK: ClaudeSDK | null = null

interface ClaudeSession {
  sessionId: string // Claude's internal session ID
  queryIterator: Query | null
  abortController: AbortController | null
  status: 'idle' | 'busy' | 'error'
  messageBuffer: SDKMessage[]
  streamTask: Promise<void> | null
  lastError: string | null
  config: SessionConfig // Store config for later use
}

export class ClaudeCodeAdapter implements CodingAgentAdapter {
  private sessions = new Map<string, ClaudeSession>()
  private sdkLoading: Promise<void> | null = null
  private claudeExecutablePath: string | null = null

  constructor() {
    this.sdkLoading = this.loadSDK()
  }

  /**
   * Find the Claude CLI executable path
   */
  private async findClaudeExecutable(): Promise<string> {
    if (this.claudeExecutablePath) {
      return this.claudeExecutablePath
    }

    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const execFileAsync = promisify(execFile)

      // Try to find claude in PATH
      const { stdout } = await execFileAsync('which', ['claude'])
      this.claudeExecutablePath = stdout.trim()
      console.log(`[ClaudeCodeAdapter] Found claude executable at: ${this.claudeExecutablePath}`)
      return this.claudeExecutablePath
    } catch (error) {
      // Common installation locations
      const commonPaths = [
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        `${process.env.HOME}/.local/bin/claude`,
        `${process.env.HOME}/.npm-global/bin/claude`
      ]

      const { existsSync } = await import('fs')
      for (const path of commonPaths) {
        if (existsSync(path)) {
          this.claudeExecutablePath = path
          console.log(`[ClaudeCodeAdapter] Found claude executable at: ${this.claudeExecutablePath}`)
          return this.claudeExecutablePath
        }
      }

      throw new Error('Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code')
    }
  }

  /**
   * Build environment variables for Claude process
   * Removes CLAUDECODE to prevent nested session errors
   */
  private buildClaudeEnvironment(): Record<string, string> {
    const env = { ...process.env } as Record<string, string>

    // Remove CLAUDECODE to prevent nested session error
    delete env.CLAUDECODE

    return env
  }

  private async loadSDK(): Promise<void> {
    try {
      ClaudeAgentSDK = await import('@anthropic-ai/claude-agent-sdk')
      console.log('[ClaudeCodeAdapter] SDK loaded successfully')
    } catch (error) {
      console.error('[ClaudeCodeAdapter] Failed to load SDK:', error)
      ClaudeAgentSDK = null
    } finally {
      this.sdkLoading = null
    }
  }

  private async ensureSDKLoaded(): Promise<void> {
    if (ClaudeAgentSDK) return
    if (this.sdkLoading) {
      await this.sdkLoading
    }
    if (!ClaudeAgentSDK) {
      throw new Error('Claude Agent SDK failed to load')
    }
  }

  async initialize(): Promise<void> {
    await this.ensureSDKLoaded()
  }

  async createSession(config: SessionConfig): Promise<string> {
    await this.ensureSDKLoaded()
    if (!ClaudeAgentSDK) {
      throw new Error('Claude Agent SDK not loaded')
    }

    // Create session state (without starting a query yet)
    // The first sendPrompt call will start the actual query
    const session: ClaudeSession = {
      sessionId: '', // Will be set from first message
      queryIterator: null,
      abortController: null,
      status: 'idle',
      messageBuffer: [],
      streamTask: null,
      lastError: null,
      config, // Store config for use in sendPrompt
    }

    // Generate UUID-format session ID (required by Claude Code)
    const { randomUUID } = await import('crypto')
    const sessionId = randomUUID()
    this.sessions.set(sessionId, session)

    console.log(`[ClaudeCodeAdapter] Session created: ${sessionId}`)
    return sessionId
  }

  /**
   * Check if a session ID is valid for Claude Code (UUID format)
   */
  private isValidClaudeSessionId(sessionId: string): boolean {
    // Claude Code expects UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    return uuidRegex.test(sessionId)
  }

  async resumeSession(
    sessionId: string,
    config: SessionConfig
  ): Promise<SessionMessage[]> {
    await this.ensureSDKLoaded()
    if (!ClaudeAgentSDK) {
      throw new Error('Claude Agent SDK not loaded')
    }

    // Validate session ID format
    if (!this.isValidClaudeSessionId(sessionId)) {
      console.warn(`[ClaudeCodeAdapter] Invalid session ID format: ${sessionId}`)
      throw new Error(
        'INCOMPATIBLE_SESSION_ID: This session was created with a different coding agent and cannot be resumed with Claude Code.'
      )
    }

    // Find Claude executable
    const claudePath = await this.findClaudeExecutable()

    // Create abort controller
    const abortController = new AbortController()

    // Build options with resume
    const options: Options = {
      cwd: config.workspaceDir,
      pathToClaudeCodeExecutable: claudePath,
      env: this.buildClaudeEnvironment(),
      mcpServers: config.mcpServers as Record<string, McpServerConfig> | undefined,
      model: config.model,
      systemPrompt: config.systemPrompt,
      abortController,
      permissionMode: 'acceptEdits',
      resume: sessionId, // Resume existing session
    }

    // Start query
    const query = ClaudeAgentSDK.query({
      prompt: '', // Resume doesn't need initial prompt
      options,
    })

    // Create session state
    const session: ClaudeSession = {
      sessionId,
      queryIterator: query,
      abortController,
      status: 'idle',
      messageBuffer: [],
      streamTask: null,
      lastError: null,
      config, // Store config
    }

    this.sessions.set(sessionId, session)

    // Start consuming stream
    session.streamTask = this.consumeStream(sessionId, session)

    // Return empty messages - polling will pick up the session replay or error
    return []
  }

  async sendPrompt(
    sessionId: string,
    parts: MessagePart[],
    config: SessionConfig
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    if (!ClaudeAgentSDK) {
      throw new Error('Claude Agent SDK not loaded')
    }

    // Extract text from parts
    const promptText = parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text!)
      .join('\n')

    if (!promptText) {
      throw new Error('No text content in prompt parts')
    }

    // Add user message to buffer so it shows in transcript
    const userMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: promptText }]
      },
      uuid: `user-prompt-${Date.now()}`,
      session_id: sessionId
    }
    session.messageBuffer.push(userMessage as SDKMessage)

    // Check if this is the first prompt (no query running yet)
    const isFirstPrompt = !session.queryIterator

    // Abort previous query if still running (only for subsequent prompts)
    if (!isFirstPrompt && session.queryIterator) {
      session.abortController?.abort()
      // Wait a bit for cleanup
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    // Find Claude executable
    const claudePath = await this.findClaudeExecutable()

    // Create new abort controller
    const abortController = new AbortController()
    session.abortController = abortController

    // Build options
    const options: Options = {
      cwd: config.workspaceDir,
      pathToClaudeCodeExecutable: claudePath,
      env: this.buildClaudeEnvironment(),
      mcpServers: config.mcpServers as Record<string, McpServerConfig> | undefined,
      model: config.model,
      systemPrompt: config.systemPrompt,
      abortController,
      permissionMode: 'acceptEdits',
      continue: !isFirstPrompt, // First prompt: new session, subsequent: continue
    }

    console.log('[ClaudeCodeAdapter] Starting query with options:', {
      cwd: options.cwd,
      pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
      model: options.model,
      permissionMode: options.permissionMode,
      continue: options.continue,
      hasEnv: !!options.env,
      hasMcpServers: !!options.mcpServers,
    })

    // Start new query
    const query = ClaudeAgentSDK.query({
      prompt: promptText,
      options,
    })

    console.log('[ClaudeCodeAdapter] Query created, starting stream consumption')

    session.queryIterator = query
    session.status = 'busy'
    if (!isFirstPrompt) {
      session.messageBuffer = [] // Clear buffer for new messages (but keep history for first prompt)
    }

    // Start consuming stream
    session.streamTask = this.consumeStream(sessionId, session)
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
    for (const sdkMsg of session.messageBuffer) {
      const msgId = this.getMessageId(sdkMsg)
      if (!msgId || seenMessageIds.has(msgId)) continue

      seenMessageIds.add(msgId)

      // Convert SDKMessage to MessagePart
      const parts = this.convertSDKMessageToParts(sdkMsg, seenPartIds, partContentLengths)
      newParts.push(...parts)
    }

    return newParts
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    session.abortController?.abort()
    session.status = 'idle'
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }

    // Abort any ongoing query
    session.abortController?.abort()

    // Wait for stream task to complete
    if (session.streamTask) {
      try {
        await session.streamTask
      } catch {
        // Ignore errors during cleanup
      }
    }

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
    // Claude Code handles MCP servers via the mcpServers option
    // They're passed per-session in createSession/resumeSession/sendPrompt
    // No global registration needed
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.ensureSDKLoaded()
      if (!ClaudeAgentSDK) {
        return { available: false, reason: 'Claude Agent SDK not loaded' }
      }
      return { available: true }
    } catch (error: any) {
      return { available: false, reason: error.message }
    }
  }

  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  /**
   * Consumes the query stream in the background and buffers messages
   */
  private async consumeStream(_sessionId: string, session: ClaudeSession): Promise<void> {
    if (!session.queryIterator) return

    console.log('[ClaudeCodeAdapter] Starting stream consumption')

    try {
      for await (const message of session.queryIterator) {
        const msg = message as any

        // Log all messages for debugging
        console.log('[ClaudeCodeAdapter] Received message:', JSON.stringify(msg, null, 2))

        // Extract session ID from first message if not set
        if (!session.sessionId && 'session_id' in msg) {
          session.sessionId = msg.session_id
          console.log(`[ClaudeCodeAdapter] Session ID set: ${session.sessionId}`)
        }

        // Check for session not found error BEFORE buffering
        if (msg.type === 'result' && msg.subtype === 'error_during_execution' && msg.is_error) {
          const errors = Array.isArray(msg.errors) ? msg.errors : []
          const sessionNotFound = errors.some((err: string) =>
            err.includes('No conversation found') || err.includes('session ID')
          )

          if (sessionNotFound) {
            console.warn('[ClaudeCodeAdapter] Session not found on Claude Code server:', errors)
            // Don't buffer this error message - throw immediately
            throw new Error(
              'INCOMPATIBLE_SESSION_ID: This session does not exist on Claude Code servers. It may have been created with a different coding agent or has expired.'
            )
          }
        }

        // Buffer message (only if we didn't throw above)
        session.messageBuffer.push(message)

        // Update status based on message type
        if (msg.type === 'status') {
          console.log(`[ClaudeCodeAdapter] Status update: ${msg.subtype}`)
          if (msg.subtype === 'busy') {
            session.status = 'busy'
          } else if (msg.subtype === 'idle') {
            session.status = 'idle'
          }
        } else if (msg.type === 'result') {
          console.log('[ClaudeCodeAdapter] Received result message')
          session.status = 'idle'
        }

        // Log stderr/stdout if present
        if (msg.type === 'stream_event' && msg.stderr) {
          console.error('[ClaudeCodeAdapter] Claude stderr:', msg.stderr)
        }
        if (msg.type === 'stream_event' && msg.stdout) {
          console.log('[ClaudeCodeAdapter] Claude stdout:', msg.stdout)
        }
      }
      console.log('[ClaudeCodeAdapter] Stream consumption completed normally')
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('[ClaudeCodeAdapter] Stream aborted by user')
      } else if (error.message?.includes('INCOMPATIBLE_SESSION_ID')) {
        // Store temporarily so resumeSession can detect and re-throw it
        console.warn('[ClaudeCodeAdapter] Incompatible session error detected')
        session.status = 'error'
        session.lastError = error.message
      } else {
        console.error('[ClaudeCodeAdapter] Stream error:', error)
        console.error('[ClaudeCodeAdapter] Error stack:', error.stack)
        console.error('[ClaudeCodeAdapter] Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
        session.status = 'error'
        session.lastError = error.message
      }
    } finally {
      console.log('[ClaudeCodeAdapter] Stream consumption ended')
      if (!session.lastError?.includes('INCOMPATIBLE_SESSION_ID')) {
        session.status = 'idle'
      }
    }
  }

  /**
   * Extracts a unique message ID from SDKMessage
   */
  private getMessageId(msg: SDKMessage): string | null {
    if ('uuid' in msg && msg.uuid) {
      return msg.uuid
    }
    if ('message_id' in msg && msg.message_id) {
      return msg.message_id as string
    }
    return null
  }

  /**
   * Converts SDKMessage to MessagePart[] format
   */
  private convertSDKMessageToParts(
    msg: SDKMessage,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>
  ): MessagePart[] {
    const parts: MessagePart[] = []
    const msgWithProps = msg as {
      type?: string
      uuid?: string
      content?: unknown[]
      message?: {
        content?: unknown[]
        text?: string
        role?: string
        id?: string
      }
      tool_use_id?: string
      tool_name?: string
      status?: string
      output?: unknown
      subtype?: string
      text?: string
      tool_use_result?: {
        content?: string
        filenames?: string[]
        mode?: string
        durationMs?: number
      }
    }

    // Handle assistant_message type
    if (msgWithProps.type === 'assistant' || msgWithProps.type === 'assistant_message') {
      // Content is nested inside message.content for Claude Code SDK format
      const content = msgWithProps.message?.content || (Array.isArray(msgWithProps.content) ? msgWithProps.content : [])

      for (const block of content) {
        const blockWithProps = block as { type?: string; text?: string; name?: string; input?: unknown; id?: string }
        const partId = `${msgWithProps.uuid || msgWithProps.type}-${blockWithProps.type}-${blockWithProps.id || Date.now()}`
        if (seenPartIds.has(partId)) continue
        seenPartIds.add(partId)

        if (blockWithProps.type === 'text') {
          const text = blockWithProps.text || ''
          partContentLengths.set(partId, String(text.length))
          parts.push({
            id: partId,
            type: MessagePartType.TEXT,
            text,
          })
        } else if (blockWithProps.type === 'tool_use') {
          const toolName = blockWithProps.name || 'unknown'
          const input = blockWithProps.input ? JSON.stringify(blockWithProps.input, null, 2) : undefined
          const toolUseId = blockWithProps.id || ''

          // Use tool_use_id as partId so we can update it when result arrives
          const toolPartId = `tool-${toolUseId}`
          if (seenPartIds.has(toolPartId)) continue
          seenPartIds.add(toolPartId)

          partContentLengths.set(toolPartId, `pending:${toolName}`)
          parts.push({
            id: toolPartId,
            type: MessagePartType.TOOL,
            content: `Tool: ${toolName}`,
            tool: {
              name: toolName,
              status: 'pending',
              input,
            },
          })
        }
      }
    } else if (msgWithProps.type === 'user' || msgWithProps.type === 'user_message') {
      // User messages contain tool results or text
      const content = msgWithProps.message?.content || (Array.isArray(msgWithProps.content) ? msgWithProps.content : [])

      for (const block of content) {
        const blockWithProps = block as {
          type?: string
          tool_use_id?: string
          content?: string
          text?: string
        }

        // Handle user text messages
        if (blockWithProps.type === 'text' && blockWithProps.text) {
          const partId = `${msgWithProps.uuid || 'user'}-text`
          if (!seenPartIds.has(partId)) {
            seenPartIds.add(partId)
            const text = blockWithProps.text
            partContentLengths.set(partId, String(text.length))
            parts.push({
              id: partId,
              type: MessagePartType.TEXT,
              text,
              role: 'user', // User messages
            })
          }
        } else if (blockWithProps.type === 'tool_result' && blockWithProps.tool_use_id) {
          const toolPartId = `tool-${blockWithProps.tool_use_id}`
          const resultContent = blockWithProps.content || ''

          // Check if we already sent the pending tool call
          const previousContent = partContentLengths.get(toolPartId)
          if (previousContent) {
            // Update the existing tool part - mark as completed
            partContentLengths.set(toolPartId, `success:${resultContent.length}`)
            parts.push({
              id: toolPartId,
              type: MessagePartType.TOOL,
              content: `Tool completed`,
              tool: {
                name: previousContent.split(':')[1] || 'tool',
                status: 'success',
                output: resultContent.slice(0, 2000),
              },
              update: true, // Mark as update to existing message
            })
          } else {
            // Tool call wasn't seen yet, send result only
            if (!seenPartIds.has(toolPartId)) {
              seenPartIds.add(toolPartId)
              partContentLengths.set(toolPartId, `success:${resultContent.length}`)
              parts.push({
                id: toolPartId,
                type: MessagePartType.TOOL,
                content: `Tool result`,
                tool: {
                  name: 'tool',
                  status: 'success',
                  output: resultContent.slice(0, 2000),
                },
              })
            }
          }
        }
      }
    } else if (msgWithProps.type === 'tool_use_summary') {
      const partId = `tool-${msgWithProps.tool_use_id || Date.now()}`
      if (!seenPartIds.has(partId)) {
        seenPartIds.add(partId)

        const toolName = msgWithProps.tool_name || 'unknown'
        const status = msgWithProps.status || 'unknown'
        const output = msgWithProps.output ? String(msgWithProps.output).slice(0, 2000) : undefined

        partContentLengths.set(partId, `${status}:${output?.length || 0}`)
        parts.push({
          id: partId,
          type: MessagePartType.TOOL,
          content: `${toolName} — ${status}`,
          tool: {
            name: toolName,
            status,
            output,
          },
        })
      }
    } else if (msgWithProps.type === 'system') {
      // Skip system init messages - they're internal session setup
      if (msgWithProps.subtype === 'init') {
        return parts
      }

      const partId = `system-${msgWithProps.uuid || Date.now()}`
      if (!seenPartIds.has(partId)) {
        seenPartIds.add(partId)

        const content = msgWithProps.subtype || 'System message'
        partContentLengths.set(partId, String(content.length))
        parts.push({
          id: partId,
          type: MessagePartType.TEXT,
          content,
        })
      }
    }

    return parts
  }
}
