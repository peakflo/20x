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
import { SessionStatusType, MessagePartType, MessageRole } from './coding-agent-adapter'

type ClaudeSDK = typeof import('@anthropic-ai/claude-agent-sdk')
type Query = import('@anthropic-ai/claude-agent-sdk').Query
type SDKMessage = import('@anthropic-ai/claude-agent-sdk').SDKMessage
type Options = import('@anthropic-ai/claude-agent-sdk').Options
type McpServerConfig = import('@anthropic-ai/claude-agent-sdk').McpServerConfig
type HookCallback = import('@anthropic-ai/claude-agent-sdk').HookCallback
type HookCallbackMatcher = import('@anthropic-ai/claude-agent-sdk').HookCallbackMatcher

let ClaudeAgentSDK: ClaudeSDK | null = null

/** Maximum number of messages to keep in the buffer per session */
const MAX_MESSAGE_BUFFER_SIZE = 500

interface ClaudeSession {
  sessionId: string // Claude's internal session ID
  queryIterator: Query | null
  abortController: AbortController | null
  status: 'idle' | 'busy' | 'error'
  messageBuffer: SDKMessage[]
  /** Index of the first unprocessed message in messageBuffer (cursor-based tracking) */
  messageCursor: number
  streamTask: Promise<void> | null
  lastError: string | null
  config: SessionConfig // Store config for later use
  isResumed?: boolean // True if this session was resumed from persistence
}

export class ClaudeCodeAdapter implements CodingAgentAdapter {
  private sessions = new Map<string, ClaudeSession>()
  private sdkLoading: Promise<void> | null = null
  private claudeExecutablePath: string | null = null

  /**
   * Callback set by agent-manager to trigger an immediate poll cycle
   * when new stream data is buffered.  Eliminates the up-to-2-second
   * latency of the fixed-interval polling heartbeat.
   */
  onDataAvailable?: (sessionId: string) => void

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
    } catch {
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
   * Removes CLAUDECODE to prevent nested session errors.
   * When secrets are configured, sets SHELL to the secret-shell.sh wrapper
   * so every bash command fetches secrets from the broker transparently.
   */
  private buildClaudeEnvironment(): Record<string, string> {
    const env = { ...process.env } as Record<string, string>

    // Remove CLAUDECODE to prevent nested session error
    delete env.CLAUDECODE

    return env
  }

  /**
   * Build PreToolUse hooks for secret injection.
   * Registers a hook that prepends `export KEY='value'` lines to each Bash command.
   * The LLM never sees the modified command — only the original tool call and
   * the output appear in conversation context.
   */
  private buildSecretHooks(config: SessionConfig): Partial<Record<string, HookCallbackMatcher[]>> | undefined {
    const secretEnvVars = config.secretEnvVars
    if (!secretEnvVars || Object.keys(secretEnvVars).length === 0) {
      return undefined
    }

    // Build shell export lines — single-quote values, escape embedded quotes
    const exportLines = Object.entries(secretEnvVars)
      .map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
      .join('\n')

    console.log(`[ClaudeCodeAdapter] Registering PreToolUse hook for secrets: [${Object.keys(secretEnvVars).join(', ')}]`)

    const hook: HookCallback = async (input) => {
      const toolInput = ('tool_input' in input ? input.tool_input : undefined) as Record<string, unknown> | undefined
      if (!toolInput?.command) {
        return {}
      }

      // Prepend secret exports to the bash command
      const originalCommand = toolInput.command as string
      const modifiedCommand = exportLines + '\n' + originalCommand

      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          updatedInput: {
            ...toolInput,
            command: modifiedCommand
          }
        }
      }
    }

    return {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [hook]
      }]
    }
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
      messageCursor: 0,
      streamTask: null,
      lastError: null,
      config, // Store config for use in sendPrompt
      isResumed: false, // New session, not resumed
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


  /**
   * Load conversation history from Claude session file
   */
  /**
   * Cleans the session file by removing messages with empty text blocks
   * This prevents API errors when resuming sessions
   */
  private async cleanSessionFile(sessionId: string, workspaceDir: string): Promise<void> {
    try {
      const { readFileSync, writeFileSync, existsSync } = await import('fs')
      const { join } = await import('path')
      const { homedir } = await import('os')

      const claudeDir = join(homedir(), '.claude', 'projects')
      // Claude Code CLI encodes workspace paths by replacing all non-alphanumeric/non-hyphen chars with '-'
      const encodedWorkspace = workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-')
      const sessionFile = join(claudeDir, encodedWorkspace, `${sessionId}.jsonl`)

      console.log(`[ClaudeCodeAdapter] Cleaning session file: ${sessionFile}`)

      // Check if session file exists
      if (!existsSync(sessionFile)) {
        console.log(`[ClaudeCodeAdapter] Session file not found, skipping clean: ${sessionFile}`)
        return
      }

      const content = readFileSync(sessionFile, 'utf-8')
      const lines = content.trim().split('\n')
      const cleanedLines: string[] = []

      for (const line of lines) {
        const entry = JSON.parse(line)

        // Keep non-message entries as-is
        if (entry.type !== 'user' && entry.type !== 'assistant') {
          cleanedLines.push(line)
          continue
        }

        // Check if message has content with empty text blocks
        if (entry.message?.content) {
          let hasEmptyText = false
          for (const contentPart of entry.message.content) {
            if (contentPart.type === 'text' && (!contentPart.text || contentPart.text.trim() === '')) {
              hasEmptyText = true
              break
            }
          }

          // Skip messages with empty text blocks
          if (hasEmptyText) {
            console.log(`[ClaudeCodeAdapter] Removing message with empty text block: ${entry.uuid}`)
            continue
          }
        }

        cleanedLines.push(line)
      }

      // Write cleaned content back
      writeFileSync(sessionFile, cleanedLines.join('\n') + '\n', 'utf-8')
      console.log(`[ClaudeCodeAdapter] Session file cleaned: ${lines.length} -> ${cleanedLines.length} lines`)
    } catch (error) {
      console.warn(`[ClaudeCodeAdapter] Failed to clean session file:`, error)
      // Don't throw - let resume attempt proceed even if cleaning fails
    }
  }

  private async loadSessionHistory(sessionId: string, workspaceDir: string): Promise<SessionMessage[]> {
    try {
      const { readFileSync, existsSync } = await import('fs')
      const { join } = await import('path')
      const { homedir } = await import('os')

      // Session files are stored in: ~/.claude/projects/[encoded-workspace]/[sessionId].jsonl
      // Claude Code CLI encodes workspace paths by replacing all non-alphanumeric/non-hyphen chars with '-'
      const claudeDir = join(homedir(), '.claude', 'projects')
      const encodedWorkspace = workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-')
      const sessionFile = join(claudeDir, encodedWorkspace, `${sessionId}.jsonl`)

      console.log(`[ClaudeCodeAdapter] Loading session history from: ${sessionFile}`)

      // Check if session file exists
      if (!existsSync(sessionFile)) {
        console.warn(`[ClaudeCodeAdapter] Session file not found: ${sessionFile}`)
        throw new Error('SESSION_FILE_NOT_FOUND: The Claude Code session file does not exist. This may happen if the session was deleted or never synced.')
      }

      const content = readFileSync(sessionFile, 'utf-8')
      const lines = content.trim().split('\n')
      const messages: SessionMessage[] = []
      // Map tool_use_id → part reference so tool_result can merge into it
      const toolUseParts = new Map<string, MessagePart['tool']>()

      for (const line of lines) {
        const entry = JSON.parse(line)

        // Skip non-message entries (queue-operation, etc.)
        if (entry.type !== 'user' && entry.type !== 'assistant') continue

        const message: SessionMessage = {
          id: entry.uuid,
          role: entry.type === 'user' ? MessageRole.USER : MessageRole.ASSISTANT,
          parts: []
        }

        // Parse message content
        if (entry.message?.content) {
          for (const contentPart of entry.message.content) {
            if (contentPart.type === 'text') {
              // Skip empty text blocks (corrupt messages)
              if (!contentPart.text || contentPart.text.trim() === '') continue

              message.parts.push({
                type: MessagePartType.TEXT,
                text: contentPart.text,
                content: contentPart.text
              })
            } else if (contentPart.type === 'tool_use') {
              const rawInput = contentPart.input as Record<string, unknown> | undefined
              const toolName = contentPart.name || 'unknown'
              const title = this.buildToolTitle(toolName, rawInput)
              const input = rawInput ? JSON.stringify(rawInput, null, 2) : undefined
              const toolObj: MessagePart['tool'] = {
                name: toolName,
                status: 'pending',
                title,
                input,
              }

              // Detect TodoWrite → set todowrite type and extract todos
              let partType: string = MessagePartType.TOOL
              let todos = rawInput?.todos
              if (typeof todos === 'string') { try { todos = JSON.parse(todos) } catch {} }
              if (Array.isArray(todos) && todos.length > 0) {
                partType = 'todowrite'
                toolObj.todos = todos.map((t: Record<string, unknown>, i: number) => ({
                  id: t.id || `todo-${i}`,
                  content: t.content || '',
                  status: t.status || 'pending',
                  priority: t.priority,
                }))
              }

              // Detect AskUserQuestion → set question type and extract questions
              let questions = rawInput?.questions
              if (typeof questions === 'string') { try { questions = JSON.parse(questions) } catch {} }
              if (Array.isArray(questions) && questions.length > 0) {
                partType = 'question'
                toolObj.questions = questions
              }

              // Detect EnterPlanMode / ExitPlanMode → set planreview type
              // For ExitPlanMode, the plan content is in input.plan (not in tool_result)
              if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') {
                partType = 'planreview'
                toolObj.title = toolName === 'EnterPlanMode' ? 'Enter plan mode' : 'Exit plan mode'
                if (toolName === 'ExitPlanMode' && rawInput?.plan) {
                  toolObj.output = String(rawInput.plan).slice(0, 50000)
                }
              }

              message.parts.push({ type: partType as MessagePartType, tool: toolObj })
              if (contentPart.id) toolUseParts.set(contentPart.id, toolObj)
            } else if (contentPart.type === 'tool_result' && contentPart.tool_use_id) {
              // Merge result into the matching tool_use part instead of creating separate entry
              const matchingTool = toolUseParts.get(contentPart.tool_use_id)
              if (matchingTool) {
                matchingTool.status = 'success'
                // Plan content should not be truncated (cap at 50K for safety)
                const isPlan = matchingTool.name === 'ExitPlanMode' || matchingTool.name === 'EnterPlanMode'
                const rawContent = contentPart.content ? String(contentPart.content) : undefined
                // Filter out confirmation prompts like "Exit/Enter plan mode?"
                const sanitized = isPlan && rawContent && /^(exit|enter) plan mode\??$/i.test(rawContent.trim())
                  ? undefined : rawContent
                matchingTool.output = sanitized
                  ? (isPlan ? sanitized.slice(0, 50000) : sanitized.slice(0, 2000))
                  : undefined
              }
              // Don't push a separate part — result is merged into tool_use
            }
          }
        }

        if (message.parts.length > 0) {
          messages.push(message)
        }
      }

      console.log(`[ClaudeCodeAdapter] Loaded ${messages.length} messages from session history`)
      return messages
    } catch (error: unknown) {
      // Re-throw session file not found errors
      const errMsg = error instanceof Error ? error.message : String(error)
      if (errMsg.includes('SESSION_FILE_NOT_FOUND')) {
        throw error
      }
      // For other errors, warn and return empty array
      console.warn(`[ClaudeCodeAdapter] Failed to load session history:`, errMsg)
      return []
    }
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

    // Clean session file to remove empty text blocks before resuming
    await this.cleanSessionFile(sessionId, config.workspaceDir)

    // Create session state (idle until user sends a message)
    const session: ClaudeSession = {
      sessionId,
      queryIterator: null, // Will be created when user sends first message
      abortController: null,
      status: 'idle',
      messageBuffer: [],
      messageCursor: 0,
      streamTask: null,
      lastError: null,
      config, // Store config for later use
      isResumed: true, // Resumed from persistence
    }

    this.sessions.set(sessionId, session)

    // Don't start query yet - wait for user to send a message
    // The query will be started in sendPrompt with resume option
    console.log(`[ClaudeCodeAdapter] Session resumed: ${sessionId} (waiting for user prompt)`)

    // Load conversation history from session file
    const messages = await this.loadSessionHistory(sessionId, config.workspaceDir)

    console.log(`[ClaudeCodeAdapter] Session loaded with ${messages.length} messages`)

    return messages
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

    // Note: Don't add user message to buffer - agent-manager already shows it
    // to avoid duplicate messages in UI

    // Check if this is the first prompt (no query running yet)
    const isFirstPrompt = !session.queryIterator

    // Abort previous query if still running (only for subsequent prompts)
    if (!isFirstPrompt && session.queryIterator) {
      session.abortController?.abort()
      // Wait for stream cleanup to complete to avoid race conditions
      if (session.streamTask) {
        try {
          await session.streamTask
        } catch {
          // Ignore errors during cleanup (abort errors are expected)
        }
      }
    }

    // Find Claude executable
    const claudePath = await this.findClaudeExecutable()

    // Create new abort controller
    const abortController = new AbortController()
    session.abortController = abortController

    // Build options
    const secretHooks = this.buildSecretHooks(config)
    const options: Options = {
      cwd: config.workspaceDir,
      pathToClaudeCodeExecutable: claudePath,
      env: this.buildClaudeEnvironment(),
      mcpServers: config.mcpServers as Record<string, McpServerConfig> | undefined,
      model: config.model,
      systemPrompt: config.systemPrompt,
      abortController,
      permissionMode: 'bypassPermissions', // Auto-approve all actions (user has already chosen to run agent)
      allowDangerouslySkipPermissions: true, // Required for bypassPermissions mode
      ...(secretHooks ? { hooks: secretHooks } : {}),
    }

    // Determine session continuation mode
    if (isFirstPrompt && session.isResumed) {
      // First prompt after resume: use resume to load persisted session
      options.resume = sessionId
      // Don't use continue with resume - they're mutually exclusive
    } else if (!isFirstPrompt) {
      // Subsequent prompts: continue existing session in same process
      options.continue = true
    }
    // Otherwise: new session, no continue/resume needed

    console.log('[ClaudeCodeAdapter] Starting query with options:', {
      cwd: options.cwd,
      pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
      model: options.model,
      permissionMode: options.permissionMode,
      continue: options.continue,
      resume: options.resume,
      isFirstPrompt,
      isResumed: session.isResumed,
      promptLength: promptText.length,
      promptPreview: promptText.substring(0, 100),
      hasEnv: !!options.env,
      hasMcpServers: !!options.mcpServers,
      mcpServerNames: options.mcpServers ? Object.keys(options.mcpServers) : [],
    })

    // Start new query
    const query = ClaudeAgentSDK.query({
      prompt: promptText,
      options,
    })

    console.log('[ClaudeCodeAdapter] Query created, starting stream consumption')

    session.queryIterator = query
    session.status = 'busy'
    session.lastError = null // Clear any previous error (e.g., rate limit) for recovery
    if (!isFirstPrompt) {
      session.messageBuffer = [] // Clear buffer for new messages (but keep history for first prompt)
      session.messageCursor = 0
    }

    // After first prompt in a resumed session, clear the flag so subsequent prompts use continue
    if (isFirstPrompt && session.isResumed) {
      session.isResumed = false
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
    _seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    _config: SessionConfig
  ): Promise<MessagePart[]> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return []
    }

    const newParts: MessagePart[] = []

    // Process only NEW buffered messages using cursor (avoids re-scanning entire buffer)
    const bufferLen = session.messageBuffer.length
    for (let i = session.messageCursor; i < bufferLen; i++) {
      const sdkMsg = session.messageBuffer[i]
      const msgId = this.getMessageId(sdkMsg)
      if (!msgId) continue

      // Convert SDKMessage to MessagePart
      const parts = this.convertSDKMessageToParts(sdkMsg, seenPartIds, partContentLengths)
      newParts.push(...parts)
    }
    // Advance cursor past processed messages
    session.messageCursor = bufferLen

    // If we have the real Claude session ID and it's different from the map key,
    // include it in the first part so agent-manager can update the database
    if (session.sessionId && session.sessionId !== sessionId && newParts.length > 0) {
      newParts[0].realSessionId = session.sessionId
    }

    return newParts
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    console.log(`[ClaudeCodeAdapter] Aborting session ${sessionId}`)
    session.abortController?.abort()

    // Wait for stream to finish cleanup
    if (session.streamTask) {
      console.log(`[ClaudeCodeAdapter] Waiting for stream cleanup...`)
      try {
        await session.streamTask
      } catch {
        // Ignore abort errors
      }
      console.log(`[ClaudeCodeAdapter] Stream cleanup complete`)
    }

    session.status = 'idle'
    console.log(`[ClaudeCodeAdapter] Session ${sessionId} aborted and set to idle`)
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

    // Remove all references to this session (both temp ID and real ID)
    // Since re-keying keeps both keys, we need to clean up both
    const keysToDelete: string[] = []
    for (const [key, sess] of this.sessions.entries()) {
      if (sess === session) {
        keysToDelete.push(key)
      }
    }

    for (const key of keysToDelete) {
      this.sessions.delete(key)
      console.log(`[ClaudeCodeAdapter] Removed session key: ${key}`)
    }
  }

  async getAllMessages(sessionId: string, _config: SessionConfig): Promise<SessionMessage[]> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return []
    }

    // Reuse the same convertSDKMessageToParts() that the live streaming path uses.
    // This ensures replay produces the same message structure (IDs, content, tool
    // fields) as the original live stream, which is critical for:
    //   - Correct content extraction from nested message.content[] arrays
    //   - Proper tool names (tool_name vs name), statuses, and titles
    //   - Consistent part IDs so mobile dedup works on reconnect
    const seenPartIds = new Set<string>()
    const partContentLengths = new Map<string, string>()

    const messages: SessionMessage[] = []
    let currentMessage: SessionMessage | null = null
    let messageIdCounter = 0

    for (const msg of session.messageBuffer) {
      // Derive role from message type
      const msgRecord = msg as unknown as Record<string, unknown>
      const roleStr = (msgRecord.role || (msg.type === 'user' ? 'user' : 'assistant')) as string
      const role = roleStr === 'user' ? MessageRole.USER :
                   roleStr === 'system' ? MessageRole.SYSTEM :
                   MessageRole.ASSISTANT

      // Convert using the full SDK message parser
      const parts = this.convertSDKMessageToParts(msg, seenPartIds, partContentLengths)
      if (parts.length === 0) continue

      // Start new message if role changed
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

      currentMessage!.parts.push(...parts)
    }

    // Push last message
    if (currentMessage) {
      messages.push(currentMessage)
    }

    return messages
  }

  async respondToQuestion(
    sessionId: string,
    answers: Record<string, string>,
    config: SessionConfig
  ): Promise<void> {
    // Claude Code runs with bypassPermissions, so AskUserQuestion ends the
    // session turn (it appears in permission_denials in the result message).
    // Send the user's answer as a follow-up prompt to continue the conversation.
    const answerText = Object.values(answers).filter(Boolean).join('\n')
    if (!answerText) {
      console.warn(`[ClaudeCodeAdapter] respondToQuestion called with empty answers for session ${sessionId}`)
      return
    }

    console.log(`[ClaudeCodeAdapter] Sending question answer as follow-up prompt for session ${sessionId}`)
    await this.sendPrompt(
      sessionId,
      [{ type: MessagePartType.TEXT, text: answerText }],
      config
    )
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
    } catch (error: unknown) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  /**
   * Safely logs a message by truncating large base64 content
   */
  /**
   * Lightweight message logger — only logs type/subtype to avoid blocking
   * the event loop with expensive JSON serialization on every streaming chunk.
   */
  private safeLogMessage(msg: SDKMessage): void {
    if (!msg || typeof msg !== 'object') return
    const m = msg as unknown as Record<string, unknown>
    console.log(`[ClaudeCodeAdapter] msg: type=${m.type} subtype=${m.subtype || '-'}`)
  }

  /**
   * Consumes the query stream in the background and buffers messages
   */
  private async consumeStream(sessionId: string, session: ClaudeSession): Promise<void> {
    if (!session.queryIterator) return

    console.log('[ClaudeCodeAdapter] Starting stream consumption')

    try {
      let messagesSinceYield = 0
      for await (const message of session.queryIterator) {
        // Guard against undefined/null messages from the SDK (can happen during
        // process crashes, lock acquisition failures, or SDK bugs)
        if (!message || typeof message !== 'object') {
          console.warn('[ClaudeCodeAdapter] Received invalid message from SDK, skipping:', typeof message)
          continue
        }

        const msg = message as unknown as Record<string, unknown>

        // ── Prevent microtask starvation ──
        // When the subprocess sends a burst of messages, the async iterator
        // resolves each next() as a microtask without ever yielding to the
        // macrotask queue.  This starves IPC, timers, and rendering callbacks,
        // making the UI completely unresponsive (loading cursor).
        // Yield every 5 messages so the event loop can process I/O.
        messagesSinceYield++
        if (messagesSinceYield >= 5) {
          messagesSinceYield = 0
          await new Promise<void>((r) => setImmediate(r))
        }

        // Log message with truncation for large content
        this.safeLogMessage(message)

        // Extract real Claude Code session ID from first message
        if (!session.sessionId && 'session_id' in msg) {
          const realSessionId = msg.session_id as string
          session.sessionId = realSessionId
          console.log(`[ClaudeCodeAdapter] Claude Code session ID: ${realSessionId}`)

          // Add the session under the real ID (keep old ID too until agent-manager updates)
          // This allows pollMessages to work with both IDs during transition
          if (realSessionId !== sessionId) {
            console.log(`[ClaudeCodeAdapter] Adding session under real ID: ${realSessionId} (keeping temp ID ${sessionId} until agent-manager updates)`)
            this.sessions.set(realSessionId as string, session)
            // Don't delete the old sessionId yet - agent-manager needs to poll with it
            // to receive the realSessionId. The old key will be deleted by destroySession
            // or when agent-manager explicitly removes it.
          }
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

        // Handle error result messages (e.g., rate limits) before treating as normal
        if (msg.type === 'result' && msg.is_error) {
          const raw = msg as Record<string, unknown>
          // Extract meaningful error text from all available fields:
          // - `result` may be a string or object
          // - `errors` may be an array of error strings
          // - `error` may be a string
          const resultField = raw.result
          const errorsField = Array.isArray(raw.errors) ? raw.errors : []
          const errorField = typeof raw.error === 'string' ? raw.error : ''
          const subtypeField = typeof raw.subtype === 'string' ? raw.subtype : ''

          let errorText: string
          if (typeof resultField === 'string' && resultField.length > 0) {
            errorText = resultField
          } else if (errorsField.length > 0) {
            errorText = errorsField.map(String).join('; ')
          } else if (errorField) {
            errorText = errorField
          } else if (resultField && typeof resultField === 'object') {
            errorText = JSON.stringify(resultField)
          } else if (subtypeField) {
            errorText = `Error during ${subtypeField}`
          } else {
            errorText = 'Unknown error (no details in result message)'
          }

          console.warn('[ClaudeCodeAdapter] Received error result:', errorText)
          console.warn('[ClaudeCodeAdapter] Full error result message:', JSON.stringify(raw, null, 2))
          session.status = 'error'
          session.lastError = errorText
        }

        // Buffer message (only if we didn't throw above)
        session.messageBuffer.push(message)

        // Cap buffer size to prevent unbounded memory growth.
        // Drop already-processed messages from the front when limit is exceeded.
        if (session.messageBuffer.length > MAX_MESSAGE_BUFFER_SIZE) {
          const drop = session.messageBuffer.length - MAX_MESSAGE_BUFFER_SIZE
          session.messageBuffer.splice(0, drop)
          session.messageCursor = Math.max(0, session.messageCursor - drop)
        }

        // Notify the polling coordinator that new data is available so it can
        // deliver this message to the UI immediately instead of waiting for
        // the next 2-second heartbeat tick.
        if (this.onDataAvailable) {
          this.onDataAvailable(sessionId)
        }

        // Update status based on message type
        if (msg.type === 'status') {
          console.log(`[ClaudeCodeAdapter] Status update: ${msg.subtype}`)
          if (msg.subtype === 'busy') {
            session.status = 'busy'
          } else if (msg.subtype === 'idle') {
            session.status = 'idle'
          }
        } else if (msg.type === 'result' && !msg.is_error) {
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
    } catch (error: unknown) {
      const errName = error instanceof Error ? error.name : ''
      const errMsg = error instanceof Error ? error.message : String(error)
      const errStack = error instanceof Error ? error.stack : undefined
      if (errName === 'AbortError' || errMsg.includes('aborted by user')) {
        console.log('[ClaudeCodeAdapter] Stream aborted by user')
        // Don't set error status - this is normal when sending a new message
      } else if (errMsg.includes('INCOMPATIBLE_SESSION_ID')) {
        // Store temporarily so resumeSession can detect and re-throw it
        console.warn('[ClaudeCodeAdapter] Incompatible session error detected')
        session.status = 'error'
        session.lastError = errMsg
      } else if (errMsg.includes('exited with code 1')) {
        // Claude Code process failed - could be rate limit, resume failure, or other error
        console.error('[ClaudeCodeAdapter] Claude Code process failed:', errMsg)
        // Only treat as incompatible session if this was a resumed session AND we
        // don't already have a specific error from the result message (e.g., rate limits).
        // Note: session.config is always set, so only check session.isResumed here.
        if (!session.lastError && session.isResumed) {
          console.warn('[ClaudeCodeAdapter] Resume failed - session may not exist on Claude servers')
          session.status = 'error'
          session.lastError = 'INCOMPATIBLE_SESSION_ID: Failed to resume session. The session may have expired or does not exist on Claude Code servers.'
        } else if (!session.lastError) {
          session.status = 'error'
          session.lastError = errMsg
        }
      } else {
        console.error('[ClaudeCodeAdapter] Stream error:', error)
        console.error('[ClaudeCodeAdapter] Error stack:', errStack)
        console.error('[ClaudeCodeAdapter] Error details:', JSON.stringify(error, error instanceof Error ? Object.getOwnPropertyNames(error) : undefined, 2))
        session.status = 'error'
        session.lastError = errMsg
      }
    } finally {
      console.log('[ClaudeCodeAdapter] Stream consumption ended')
      if (session.status === 'error') {
        // Reset queryIterator so the next sendPrompt starts a fresh process
        // instead of setting `continue: true` on a dead process (which would
        // immediately fail again, trapping the user in an error loop).
        session.queryIterator = null
      } else {
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
      status?: string | null
      output?: unknown
      subtype?: string
      text?: string
      tool_use_result?: {
        content?: string
        filenames?: string[]
        mode?: string
        durationMs?: number
      }
      // SDKToolProgressMessage fields
      elapsed_time_seconds?: number
      parent_tool_use_id?: string | null
      // SDKTaskNotificationMessage / SDKTaskProgressMessage / SDKTaskStartedMessage fields
      task_id?: string
      summary?: string
      output_file?: string
      description?: string
      last_tool_name?: string
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
      task_type?: string
      prompt?: string
    }

    // ── Skip messages from inside a subtask ──
    // Messages originating from a subagent task have a non-null parent_tool_use_id.
    // These would otherwise leak as top-level user messages / tool calls in the
    // transcript.  The task_started / task_progress / task_notification events
    // already provide the high-level summary, so we suppress the inner messages.
    // Exception: system messages (task_started, task_progress, task_notification,
    // status) do NOT carry parent_tool_use_id and must always be processed.
    if (msgWithProps.parent_tool_use_id) {
      return parts
    }

    // Handle assistant_message type
    if (msgWithProps.type === 'assistant' || msgWithProps.type === 'assistant_message') {
      // Content is nested inside message.content for Claude Code SDK format
      const content = msgWithProps.message?.content || (Array.isArray(msgWithProps.content) ? msgWithProps.content : [])

      // Use the stable API message ID (e.g. msg_01FG7...) for dedup, not the streaming UUID.
      // Claude Code sends multiple streaming chunks with different UUIDs but the same API message ID
      // and the same text block, which would otherwise create duplicate text bubbles in the UI.
      const stableId = msgWithProps.message?.id || msgWithProps.uuid || msgWithProps.type

      for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
        const block = content[blockIdx]
        const blockWithProps = block as { type?: string; text?: string; name?: string; input?: unknown; id?: string }
        // For text blocks (no id), use stable message ID + block index for consistent dedup.
        // For tool_use blocks, blockWithProps.id is the tool_use_id which is already stable.
        const partId = `${stableId}-${blockWithProps.type}-${blockWithProps.id || blockIdx}`
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
          const rawInput = blockWithProps.input as Record<string, unknown> | undefined
          const input = rawInput ? JSON.stringify(rawInput, null, 2) : undefined
          const toolUseId = blockWithProps.id || ''

          // Use tool_use_id as partId so we can update it when result arrives
          const toolPartId = `tool-${toolUseId}`
          if (seenPartIds.has(toolPartId)) continue
          seenPartIds.add(toolPartId)

          // Build a human-readable title from tool input (mirrors buildPartPayload for OpenCode)
          const title = this.buildToolTitle(toolName, rawInput)

          // Detect AskUserQuestion → render as interactive question
          let questions = rawInput?.questions
          if (typeof questions === 'string') {
            try { questions = JSON.parse(questions) } catch {}
          }
          if (Array.isArray(questions) && questions.length > 0) {
            partContentLengths.set(toolPartId, `pending:${toolName}`)
            parts.push({
              id: toolPartId,
              type: 'question' as MessagePartType,
              content: title || 'Question',
              tool: { name: toolName, status: 'pending', title, input, questions },
            })
            continue
          }

          // Detect TodoWrite → render as todo list
          let todos = rawInput?.todos
          if (typeof todos === 'string') {
            try { todos = JSON.parse(todos) } catch {}
          }
          if (Array.isArray(todos) && todos.length > 0) {
            // Normalize: ensure each todo has an id (Claude Code SDK omits it)
            const normalizedTodos = todos.map((t: Record<string, unknown>, i: number) => ({
              id: t.id || `todo-${i}`,
              content: t.content || '',
              status: t.status || 'pending',
              priority: t.priority,
            }))
            partContentLengths.set(toolPartId, `pending:${toolName}`)
            parts.push({
              id: toolPartId,
              type: 'todowrite' as MessagePartType,
              content: title || 'Todo List',
              tool: { name: toolName, status: 'pending', title, input, todos: normalizedTodos },
            })
            continue
          }

          // Detect EnterPlanMode / ExitPlanMode → render as plan mode indicator
          // For ExitPlanMode, the plan content is in input.plan (not in tool_result)
          if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') {
            const planTitle = toolName === 'EnterPlanMode' ? 'Enter plan mode' : 'Exit plan mode'
            const planContent = toolName === 'ExitPlanMode' && rawInput?.plan
              ? String(rawInput.plan).slice(0, 50000) : undefined
            partContentLengths.set(toolPartId, `pending:${toolName}`)
            parts.push({
              id: toolPartId,
              type: 'planreview' as MessagePartType,
              content: planTitle,
              tool: { name: toolName, status: 'pending', title: planTitle, input, output: planContent },
            })
            continue
          }

          // Regular tool call
          partContentLengths.set(toolPartId, `pending:${toolName}`)
          parts.push({
            id: toolPartId,
            type: MessagePartType.TOOL,
            content: title ? `${toolName} — ${title}` : toolName,
            tool: { name: toolName, status: 'pending', title, input },
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
          // Plan mode tools should not be truncated (cap at 50K for safety)
          const isPlanReview = previousContent?.endsWith(':ExitPlanMode') || previousContent?.endsWith(':EnterPlanMode')
          // Filter out confirmation prompts like "Exit plan mode?" / "Enter plan mode?" — not useful content
          const sanitizedResult = isPlanReview && /^(exit|enter) plan mode\??$/i.test(resultContent.trim())
            ? '' : resultContent
          const outputContent = isPlanReview
            ? sanitizedResult.slice(0, 50000)
            : resultContent.slice(0, 2000)

          if (previousContent) {
            const toolName = previousContent.split(':')[1] || 'tool'
            // Update the existing tool part - mark as completed
            partContentLengths.set(toolPartId, `success:${resultContent.length}`)
            // For plan review: don't send empty output (would overwrite plan from input.plan)
            parts.push({
              id: toolPartId,
              type: isPlanReview ? ('planreview' as MessagePartType) : MessagePartType.TOOL,
              content: isPlanReview ? (toolName === 'EnterPlanMode' ? 'Enter plan mode' : 'Exit plan mode') : `Tool completed`,
              tool: {
                name: toolName,
                status: 'success',
                ...(outputContent ? { output: outputContent } : {}),
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
                type: isPlanReview ? ('planreview' as MessagePartType) : MessagePartType.TOOL,
                content: isPlanReview ? 'Plan mode' : `Tool result`,
                tool: {
                  name: isPlanReview ? 'ExitPlanMode' : 'tool',
                  status: 'success',
                  output: outputContent,
                },
              })
            }
          }
        }
      }
    } else if (msgWithProps.type === 'tool_use_summary') {
      const partId = `tool-${msgWithProps.tool_use_id || Date.now()}`
      const toolName = msgWithProps.tool_name || 'unknown'
      const status = msgWithProps.status || 'unknown'
      const isPlanReview = toolName === 'ExitPlanMode' || toolName === 'EnterPlanMode'
      const rawOutput = msgWithProps.output ? String(msgWithProps.output) : undefined
      // Filter out confirmation prompts like "Exit/Enter plan mode?"
      const sanitizedOutput = isPlanReview && rawOutput && /^(exit|enter) plan mode\??$/i.test(rawOutput.trim())
        ? undefined : rawOutput
      const output = sanitizedOutput
        ? (isPlanReview ? sanitizedOutput.slice(0, 50000) : sanitizedOutput.slice(0, 2000))
        : undefined
      const partType = isPlanReview ? ('planreview' as MessagePartType) : MessagePartType.TOOL
      const planLabel = toolName === 'EnterPlanMode' ? 'Enter plan mode' : 'Exit plan mode'

      if (seenPartIds.has(partId)) {
        // Tool_use was already emitted — send an UPDATE to merge the result into it
        partContentLengths.set(partId, `${status}:${output?.length || 0}`)
        parts.push({
          id: partId,
          type: partType,
          content: isPlanReview ? planLabel : `${toolName} — ${status}`,
          tool: { name: toolName, status, output },
          update: true,
        })
      } else {
        // First time seeing this tool — add as new entry
        seenPartIds.add(partId)
        partContentLengths.set(partId, `${status}:${output?.length || 0}`)
        parts.push({
          id: partId,
          type: partType,
          content: isPlanReview ? planLabel : `${toolName} — ${status}`,
          tool: { name: toolName, status, output },
        })
      }
    } else if (msgWithProps.type === 'tool_progress') {
      // SDKToolProgressMessage — periodic progress updates for running tools.
      // Update the existing tool part with elapsed time so the UI shows a timer.
      const toolUseId = msgWithProps.tool_use_id
      if (toolUseId) {
        const partId = `tool-${toolUseId}`
        const toolName = msgWithProps.tool_name || 'tool'
        const elapsed = msgWithProps.elapsed_time_seconds ?? 0
        const elapsedLabel = elapsed >= 60
          ? `${Math.floor(elapsed / 60)}m ${Math.round(elapsed % 60)}s`
          : `${Math.round(elapsed)}s`

        if (seenPartIds.has(partId)) {
          // Tool was already emitted — send an update with elapsed time
          parts.push({
            id: partId,
            type: MessagePartType.TOOL,
            tool: {
              name: toolName,
              status: 'running',
              title: `Running… ${elapsedLabel}`,
            },
            update: true,
          })
        }
        // If tool hasn't been seen yet, skip — progress before tool_use is meaningless
      }
    } else if (msgWithProps.type === 'result') {
      // Surface error result messages (e.g., rate limit errors) to the UI
      const resultMsg = msg as Record<string, unknown>
      if (resultMsg.is_error) {
        // Extract error text from all available fields (result, errors, error)
        const resultField = resultMsg.result
        const errorsField = Array.isArray(resultMsg.errors) ? resultMsg.errors : []
        const errorField = typeof resultMsg.error === 'string' ? resultMsg.error : ''

        let errorText: string
        if (typeof resultField === 'string' && resultField.length > 0) {
          errorText = resultField
        } else if (errorsField.length > 0) {
          errorText = errorsField.map(String).join('; ')
        } else if (errorField) {
          errorText = errorField
        } else if (resultField && typeof resultField === 'object') {
          errorText = JSON.stringify(resultField)
        } else {
          errorText = 'An error occurred (no details available)'
        }

        const partId = `result-error-${msgWithProps.uuid || Date.now()}`
        if (!seenPartIds.has(partId)) {
          seenPartIds.add(partId)
          partContentLengths.set(partId, String(errorText.length))
          parts.push({
            id: partId,
            type: MessagePartType.TEXT,
            text: errorText,
            role: 'system',
          })
        }
      }
    } else if (msgWithProps.type === 'system') {
      // Skip system init messages - they're internal session setup
      if (msgWithProps.subtype === 'init') {
        return parts
      }

      // SDKTaskStartedMessage — subagent task started
      if (msgWithProps.subtype === 'task_started') {
        const taskId = msgWithProps.task_id || msgWithProps.uuid || `task-${Date.now()}`
        const partId = `task-${taskId}`
        if (!seenPartIds.has(partId)) {
          seenPartIds.add(partId)
          partContentLengths.set(partId, `started:${taskId}`)
          parts.push({
            id: partId,
            type: MessagePartType.TASK_PROGRESS,
            content: msgWithProps.description || 'Subagent task started',
            taskProgress: {
              taskId,
              status: 'started',
              description: msgWithProps.description || '',
            }
          })
        }
        return parts
      }

      // SDKTaskProgressMessage — periodic progress updates for running subagent tasks
      if (msgWithProps.subtype === 'task_progress') {
        const taskId = msgWithProps.task_id || `task-${Date.now()}`
        const partId = `task-${taskId}`
        const usage = msgWithProps.usage
        const alreadySeen = seenPartIds.has(partId)

        if (!alreadySeen) {
          // Missed task_started — create the entry
          seenPartIds.add(partId)
        }
        partContentLengths.set(partId, `running:${taskId}`)
        parts.push({
          id: partId,
          type: MessagePartType.TASK_PROGRESS,
          content: msgWithProps.description || 'Subagent task in progress',
          taskProgress: {
            taskId,
            status: 'running',
            description: msgWithProps.description || '',
            lastToolName: msgWithProps.last_tool_name,
            summary: msgWithProps.summary,
            usage,
          },
          update: alreadySeen,
        })
        return parts
      }

      // SDKTaskNotificationMessage — subtask completion notifications
      if (msgWithProps.subtype === 'task_notification') {
        const taskId = msgWithProps.task_id || `task-${Date.now()}`
        const partId = `task-${taskId}`
        const taskStatus = (msgWithProps.status || 'completed') as 'completed' | 'failed' | 'stopped'
        const summary = msgWithProps.summary || `Task ${taskStatus}`
        const usage = msgWithProps.usage
        const alreadySeen = seenPartIds.has(partId)

        if (!alreadySeen) {
          seenPartIds.add(partId)
        }
        partContentLengths.set(partId, `${taskStatus}:${taskId}`)
        parts.push({
          id: partId,
          type: MessagePartType.TASK_PROGRESS,
          content: summary,
          taskProgress: {
            taskId,
            status: taskStatus,
            description: summary,
            summary,
            usage,
          },
          update: alreadySeen,
        })
        return parts
      }

      // SDKStatusMessage — transient status indicators (e.g. 'compacting')
      if (msgWithProps.subtype === 'status') {
        // null status means "cleared" — skip
        if (!msgWithProps.status) return parts
        const partId = `system-status-${msgWithProps.uuid || Date.now()}`
        if (!seenPartIds.has(partId)) {
          seenPartIds.add(partId)
          const statusLabel = msgWithProps.status === 'compacting'
            ? 'Compacting conversation history…'
            : String(msgWithProps.status)
          partContentLengths.set(partId, String(statusLabel.length))
          parts.push({
            id: partId,
            type: 'system-status' as MessagePartType,
            content: statusLabel,
            role: 'system',
          })
        }
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

  /**
   * Builds a human-readable title for a tool call from its input.
   * Mirrors the titles that OpenCode/buildPartPayload produces.
   */
  private buildToolTitle(toolName: string, input?: Record<string, unknown>): string {
    if (!input) return ''

    switch (toolName) {
      case 'Bash':
        return input.command ? String(input.command) : (input.description ? String(input.description) : '')
      case 'Read':
        return input.file_path ? String(input.file_path) : ''
      case 'Edit':
      case 'Write':
        return input.file_path ? String(input.file_path) : ''
      case 'Grep':
        return input.pattern
          ? `${input.pattern}${input.path ? ` in ${input.path}` : ''}`
          : ''
      case 'Glob':
        return input.pattern ? String(input.pattern) : ''
      case 'Task':
        return input.description ? String(input.description) : ''
      case 'WebFetch':
        return input.url ? String(input.url) : ''
      case 'WebSearch':
        return input.query ? String(input.query) : ''
      case 'TodoWrite':
        return 'Todo List'
      case 'AskUserQuestion':
        return 'Question'
      case 'EnterPlanMode':
        return 'Enter plan mode'
      case 'ExitPlanMode':
        return 'Exit plan mode'
      default:
        return ''
    }
  }
}
