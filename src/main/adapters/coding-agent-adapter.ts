/**
 * Adapter interface for coding agent backends.
 * Defines common operations that all coding agent implementations must support.
 */

export enum SessionStatusType {
  IDLE = 'idle',
  BUSY = 'busy',
  RETRY = 'retry',
  ERROR = 'error'
}

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system'
}

export enum MessagePartType {
  TEXT = 'text',
  REASONING = 'reasoning',
  TOOL = 'tool',
  IMAGE = 'image',
  ERROR = 'error'
}

export interface McpServerConfig {
  name?: string
  type: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface SessionConfig {
  agentId: string
  taskId: string
  workspaceDir: string
  serverUrl?: string
  model?: string
  systemPrompt?: string
  tools?: Record<string, boolean>
  promptAbort?: AbortController
  mcpServers?: Record<string, McpServerConfig>
  apiKeys?: {
    openai?: string
    anthropic?: string
  }
  /** Port of the local secret broker HTTP server */
  secretBrokerPort?: number
  /** Per-session token for authenticating with the secret broker */
  secretSessionToken?: string
  /** Absolute path to the secret-shell.sh wrapper script */
  secretShellPath?: string
  /** Decrypted secret env vars to inject directly into the agent process env.
   *  Used when the agent runtime doesn't respect $SHELL (e.g. Claude Code). */
  secretEnvVars?: Record<string, string>
}

export interface SessionStatus {
  type: SessionStatusType
  message?: string
}

export interface SessionMessage {
  id: string
  role: MessageRole
  parts: MessagePart[]
}

export interface MessagePart {
  id?: string
  type: MessagePartType
  text?: string
  content?: string
  role?: 'user' | 'assistant' | 'system' // Message role
  tool?: {
    name: string
    status?: string
    title?: string
    input?: unknown
    output?: unknown
    error?: string
    questions?: unknown
    todos?: unknown
  }
  state?: {
    status?: string
    title?: string
    input?: unknown
    output?: unknown
    error?: string
  }
  update?: boolean // Mark as update to existing message
  realSessionId?: string // Real session ID from backend (for updating database)
}

export interface MessagePayload {
  content: string
  partType: string
  tool?: {
    name: string
    status?: string
    title?: string
    input?: unknown
    output?: unknown
    error?: string
  }
}

/**
 * Common interface for all coding agent backends (OpenCode, Claude Code, etc.)
 */
export interface CodingAgentAdapter {
  /**
   * Initialize the adapter (e.g., load SDK, validate config)
   */
  initialize(): Promise<void>

  /**
   * Create a new coding session
   * @returns OpenCode/Claude session ID
   */
  createSession(config: SessionConfig): Promise<string>

  /**
   * Resume an existing session from a persisted session ID
   * @returns Session messages for replay
   */
  resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]>

  /**
   * Send a prompt/message to the session
   */
  sendPrompt(
    sessionId: string,
    parts: MessagePart[],
    config: SessionConfig
  ): Promise<void>

  /**
   * Get current session status
   */
  getStatus(sessionId: string, config: SessionConfig): Promise<SessionStatus>

  /**
   * Get new messages since last poll
   * @param seenMessageIds Set of message IDs already processed
   * @param seenPartIds Set of part IDs already processed
   * @returns New message parts
   */
  pollMessages(
    sessionId: string,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    config: SessionConfig
  ): Promise<MessagePart[]>

  /**
   * Get all session messages in a standardized format
   * Used for extracting output fields and other post-processing
   * @returns All messages from the session
   */
  getAllMessages?(sessionId: string, config: SessionConfig): Promise<SessionMessage[]>

  /**
   * Abort ongoing prompt
   */
  abortPrompt(sessionId: string, config: SessionConfig): Promise<void>

  /**
   * Destroy/cleanup session
   */
  destroySession(sessionId: string, config: SessionConfig): Promise<void>

  /**
   * Register an MCP server with the adapter
   */
  registerMcpServer(
    serverName: string,
    mcpConfig: {
      type: 'local' | 'remote'
      command?: string[]
      args?: string[]
      url?: string
      headers?: Record<string, string>
      environment?: Record<string, string>
    },
    workspaceDir?: string
  ): Promise<void>

  /**
   * Respond to a pending question (AskUserQuestion tool call).
   * Agent-manager passes structured answers; each adapter delivers them
   * in whatever format its backend expects.
   *
   * @param answers Map of question header/label → selected answer text
   */
  respondToQuestion?(
    sessionId: string,
    answers: Record<string, string>,
    config: SessionConfig
  ): Promise<void>

  /**
   * Check if this adapter's backend is available and healthy
   */
  checkHealth(): Promise<{ available: boolean; reason?: string }>
}
