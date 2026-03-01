import { Agent as UndiciAgent } from 'undici'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import type {
  CodingAgentAdapter,
  SessionConfig,
  SessionStatus,
  SessionMessage,
  MessagePart
} from './coding-agent-adapter'
import { SessionStatusType, MessagePartType, MessageRole } from './coding-agent-adapter'

let OpenCodeSDK: typeof import('@opencode-ai/sdk') | null = null

type OpencodeClient = import('@opencode-ai/sdk').OpencodeClient
type OpenCodeV2Module = typeof import('@opencode-ai/sdk/v2/client')
type V2OpencodeClient = import('@opencode-ai/sdk/v2/client').OpencodeClient
type V2QuestionRequest = import('@opencode-ai/sdk/v2/client').QuestionRequest
let OpenCodeV2: OpenCodeV2Module | null = null

// Custom fetch with no timeout — agent prompts can run indefinitely
const noTimeoutAgent = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 })
const noTimeoutFetch = (req: unknown) => (globalThis as unknown as Record<string, (...args: unknown[]) => unknown>).fetch(req, { dispatcher: noTimeoutAgent })

const DEFAULT_SERVER_URL = 'http://localhost:4096'

/**
 * Adapter for OpenCode backend
 */
export class OpencodeAdapter implements CodingAgentAdapter {
  private sdkLoading: Promise<void> | null = null
  private serverInstance: unknown = null
  private serverUrl: string | null = null
  private serverStarting: Promise<void> | null = null
  private clients: Map<string, OpencodeClient> = new Map() // sessionId -> ocClient
  private v2Client: V2OpencodeClient | null = null
  private promptAborts: Map<string, AbortController> = new Map()
  /** Absolute path to the secret-injector plugin file (written before server start) */
  private pluginFilePath: string | null = null
  /** Absolute path to the secrets exports file (read dynamically by the plugin) */
  private secretsExportsPath: string | null = null

  constructor() {
    this.sdkLoading = this.loadSDK()
  }

  private async loadSDK(): Promise<void> {
    try {
      OpenCodeSDK = await import('@opencode-ai/sdk')
      OpenCodeV2 = await import('@opencode-ai/sdk/v2/client')
      console.log('[OpencodeAdapter] SDK loaded successfully')
    } catch (error) {
      console.error('[OpencodeAdapter] Failed to load SDK:', error)
    } finally {
      this.sdkLoading = null
    }
  }

  private async ensureSDKLoaded(): Promise<void> {
    if (OpenCodeSDK) return
    if (this.sdkLoading) {
      await this.sdkLoading
    }
    if (!OpenCodeSDK) {
      throw new Error('OpenCode SDK not loaded')
    }
  }

  async initialize(): Promise<void> {
    await this.ensureSDKLoaded()
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.ensureSDKLoaded()

      // Try to connect to default server
      const response = await fetch(`${DEFAULT_SERVER_URL}/global/health`, {
        signal: AbortSignal.timeout(2000)
      })

      if (!response.ok) {
        return { available: false, reason: 'Server not responding' }
      }

      return { available: true }
    } catch {
      return { available: false, reason: 'SDK not available or server not accessible' }
    }
  }

  private async findAccessibleServer(url: string): Promise<string | null> {
    const urls = [url]

    if (url.includes('localhost')) {
      urls.push(url.replace('localhost', '127.0.0.1'))
    } else if (url.includes('127.0.0.1')) {
      urls.push(url.replace('127.0.0.1', 'localhost'))
    }

    for (const testUrl of urls) {
      try {
        const response = await fetch(`${testUrl}/global/health`, {
          signal: AbortSignal.timeout(2000)
        })
        if (response.ok) {
          return testUrl
        }
      } catch {
        // Try next URL
      }
    }

    return null
  }

  private async ensureServerRunning(targetUrl: string = DEFAULT_SERVER_URL): Promise<void> {
    if (this.serverUrl) {
      if (this.serverUrl === targetUrl) {
        return
      }
    }

    if (this.serverStarting) {
      return this.serverStarting
    }

    await this.ensureSDKLoaded()

    const isDefaultUrl = targetUrl === DEFAULT_SERVER_URL || targetUrl === 'http://127.0.0.1:4096'

    this.serverStarting = (async () => {
      try {
        const accessibleUrl = await this.findAccessibleServer(targetUrl)
        if (accessibleUrl) {
          this.serverUrl = accessibleUrl
          this.serverInstance = null
          return
        }

        if (!isDefaultUrl) {
          throw new Error(`OpenCode server not accessible at ${targetUrl}`)
        }

        // Create embedded server
        const url = new URL(targetUrl)
        const hostname = url.hostname
        const port = parseInt(url.port || '4096', 10)

        // Pass secret-injector plugin path via config so OpenCode loads it at startup
        const serverConfig: Record<string, unknown> = {}
        if (this.pluginFilePath) {
          serverConfig.plugin = [this.pluginFilePath]
          console.log(`[OpencodeAdapter] Passing plugin to server config: ${this.pluginFilePath}`)
        }

        const result = await OpenCodeSDK!.createOpencode({ hostname, port, config: serverConfig })
        this.serverInstance = result.server
        this.serverUrl = targetUrl

        await new Promise(resolve => setTimeout(resolve, 1000))
      } finally {
        this.serverStarting = null
      }
    })()

    return this.serverStarting
  }

  async createSession(config: SessionConfig): Promise<string> {
    // Write secret files BEFORE server starts so the plugin is discovered at startup.
    // The plugin reads secrets dynamically from a file, so subsequent updates work
    // even when the server is already running.
    this.writeSecretFiles(config)

    await this.ensureServerRunning(config.serverUrl || DEFAULT_SERVER_URL)

    const baseUrl = this.serverUrl || config.serverUrl || DEFAULT_SERVER_URL
    const ocClient = OpenCodeSDK!.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch as unknown as (request: Request) => ReturnType<typeof fetch> })

    // Register secret-injector plugin via config.update() so the running server loads it
    // for this workspace directory — no server restart needed.
    if (this.pluginFilePath && config.workspaceDir) {
      try {
        await ocClient.config.update({
          body: { plugin: [this.pluginFilePath] } as Record<string, unknown>,
          ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
        })
        console.log(`[OpencodeAdapter] Registered plugin via config.update: ${this.pluginFilePath}`)
      } catch (err) {
        console.warn(`[OpencodeAdapter] config.update for plugin failed (will rely on startup loading):`, err)
      }
    }

    // Register MCP servers BEFORE creating session so the session picks them up
    if (config.mcpServers) {
      for (const [name, mcpConfig] of Object.entries(config.mcpServers)) {
        try {
          const mcpAddConfig = mcpConfig.type === 'http'
            ? { type: 'remote' as const, url: mcpConfig.url ?? '', headers: mcpConfig.headers }
            : { type: 'local' as const, command: [mcpConfig.command ?? '', ...(mcpConfig.args ?? [])], environment: mcpConfig.env }
          console.log(`[OpencodeAdapter] Registering MCP server: ${name}`, JSON.stringify(mcpAddConfig))

          // Add MCP server
          const addResult = await ocClient.mcp.add({
            body: { name, config: mcpAddConfig },
            ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
          })

          if (addResult.error) {
            console.error(`[OpencodeAdapter] mcp.add error for ${name}:`, addResult.error)
            continue
          }

          // Check the add response for immediate server status
          const addStatus = addResult.data?.[name] as { status: string; error?: string } | undefined
          if (addStatus) {
            console.log(`[OpencodeAdapter] mcp.add status for '${name}': ${addStatus.status}${addStatus.error ? ` - ${addStatus.error}` : ''}`)
            if (addStatus.status === 'failed') {
              console.error(`[OpencodeAdapter] MCP server '${name}' failed immediately after add: ${addStatus.error}`)
              continue
            }
          }

          // Connect to MCP server
          const connectResult = await ocClient.mcp.connect({
            path: { name },
            ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
          })

          if (connectResult.error) {
            console.error(`[OpencodeAdapter] mcp.connect error for ${name}:`, connectResult.error)
            continue
          }

          // Check connect result (returns boolean)
          if (connectResult.data === false) {
            console.error(`[OpencodeAdapter] mcp.connect returned false for ${name} — server failed to connect`)
            continue
          }

          // Wait for MCP server to fully connect with retries
          let connected = false
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              const statusResult = await ocClient.mcp.status({
                ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
              })
              const serverStatus = statusResult.data?.[name] as { status: string; error?: string } | undefined
              if (serverStatus) {
                if (serverStatus.status === 'connected') {
                  console.log(`[OpencodeAdapter] MCP server '${name}' status: connected (attempt ${attempt + 1})`)
                  connected = true
                  break
                } else if (serverStatus.status === 'failed') {
                  console.error(`[OpencodeAdapter] MCP server '${name}' status: failed${serverStatus.error ? ` - ${serverStatus.error}` : ''}`)
                  break
                } else {
                  console.log(`[OpencodeAdapter] MCP server '${name}' status: ${serverStatus.status}, waiting... (attempt ${attempt + 1})`)
                }
              } else {
                console.log(`[OpencodeAdapter] MCP server '${name}' not yet in status response (attempt ${attempt + 1})`)
              }
            } catch (statusErr) {
              console.warn(`[OpencodeAdapter] Failed to check MCP server status for ${name}:`, statusErr)
            }
            // Wait before retrying (500ms, 1s, 1.5s, 2s, 2.5s)
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
          }

          if (connected) {
            console.log(`[OpencodeAdapter] Successfully registered MCP server: ${name}`)
          } else {
            console.error(`[OpencodeAdapter] MCP server '${name}' did not reach connected status — tools may not work`)
          }
        } catch (mcpError) {
          console.error(`[OpencodeAdapter] Failed to register MCP server ${name}:`, mcpError)
        }
      }
    }

    // Create OpenCode session
    const result = await ocClient.session.create({
      body: { title: `Task ${config.taskId}` },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (result.error) {
      const errData = result.error as { data?: { message?: string }; name?: string }
      throw new Error(errData.data?.message || errData.name || 'Failed to create session')
    }
    if (!result.data?.id) {
      throw new Error('No session ID returned from OpenCode')
    }

    const ocSessionId = result.data.id
    this.clients.set(ocSessionId, ocClient)

    return ocSessionId
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    // Update secrets file before resuming (plugin reads dynamically)
    this.writeSecretFiles(config)

    await this.ensureServerRunning(config.serverUrl || DEFAULT_SERVER_URL)

    const baseUrl = this.serverUrl || config.serverUrl || DEFAULT_SERVER_URL
    const ocClient = OpenCodeSDK!.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch as unknown as (request: Request) => ReturnType<typeof fetch> })

    // Register secret-injector plugin for this workspace
    if (this.pluginFilePath && config.workspaceDir) {
      try {
        await ocClient.config.update({
          body: { plugin: [this.pluginFilePath] } as Record<string, unknown>,
          ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
        })
        console.log(`[OpencodeAdapter] Registered plugin via config.update: ${this.pluginFilePath}`)
      } catch (err) {
        console.warn(`[OpencodeAdapter] config.update for plugin failed:`, err)
      }
    }

    // Validate session exists
    const getResult = await ocClient.session.get({
      path: { id: sessionId },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (getResult.error || !getResult.data) {
      throw new Error('Session no longer exists on server')
    }

    this.clients.set(sessionId, ocClient)

    // Fetch existing messages
    const messagesResult = await ocClient.session.messages({
      path: { id: sessionId },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    const messages: SessionMessage[] = []
    if (messagesResult.data && Array.isArray(messagesResult.data)) {
      for (const msg of messagesResult.data) {
        if (!msg.info) continue
        const rawParts = msg.parts || []
        const transformedParts: MessagePart[] = rawParts.map((part: Record<string, unknown>) => {
          if (part.type === 'tool') {
            return this.transformToolPart(part)
          }
          return {
            id: part.id as string,
            type: part.type as MessagePartType,
            text: part.text as string,
            content: part.text as string
          }
        })
        messages.push({
          id: msg.info.id,
          role: (msg.info.role || 'assistant') as unknown as MessageRole,
          parts: transformedParts
        })
      }
    }

    return messages
  }

  async sendPrompt(sessionId: string, parts: MessagePart[], config: SessionConfig): Promise<void> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) {
      throw new Error(`No client found for session ${sessionId}`)
    }

    // Parse model from config
    let modelParam: { providerID: string; modelID: string } | undefined
    if (config.model) {
      const slashIdx = config.model.indexOf('/')
      if (slashIdx > 0) {
        modelParam = {
          providerID: config.model.slice(0, slashIdx),
          modelID: config.model.slice(slashIdx + 1)
        }
      }
    }

    const promptAbort = new AbortController()
    this.promptAborts.set(sessionId, promptAbort)

    // Fire-and-forget prompt
    ocClient.session.prompt({
      path: { id: sessionId },
      body: {
        parts: parts as unknown as Array<import('@opencode-ai/sdk').TextPartInput>,
        ...(modelParam && { model: modelParam }),
        ...(config.tools && { tools: config.tools })
      },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } }),
      signal: promptAbort.signal
    }).catch((err: unknown) => {
      if (!(err instanceof Error) || err.name !== 'AbortError') {
        console.error('[OpencodeAdapter] prompt error:', err)
      }
    }).finally(() => {
      this.promptAborts.delete(sessionId)
    })
  }

  async getStatus(sessionId: string, config: SessionConfig): Promise<SessionStatus> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) {
      return { type: SessionStatusType.ERROR, message: 'Client not found' }
    }

    const statusResult = await ocClient.session.status({
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (!statusResult.data) {
      return { type: SessionStatusType.IDLE }
    }

    const ocStatus = statusResult.data[sessionId]
    if (!ocStatus) {
      return { type: SessionStatusType.IDLE }
    }

    const sdkType = ocStatus.type || 'idle'
    const statusType = sdkType.toUpperCase() as keyof typeof SessionStatusType
    return {
      type: SessionStatusType[statusType] ?? SessionStatusType.IDLE,
      message: 'message' in ocStatus ? (ocStatus as { message: string }).message : undefined
    }
  }

  /**
   * Transforms a raw OpenCode tool part into the structured format the renderer expects.
   * OpenCode returns tool name as `part.tool` (string) and details in `part.state`.
   */
  private transformToolPart(part: Record<string, unknown>): MessagePart {
    const state = (part.state || {}) as Record<string, unknown>
    const stateInput = (state.input && typeof state.input === 'object' ? state.input : {}) as Record<string, unknown>
    const toolName = (part.tool as string) || 'unknown'
    const status = (state.status as string) || 'unknown'
    const inputStr = stateInput && Object.keys(stateInput).length > 0
      ? JSON.stringify(stateInput, null, 2) : undefined
    const outputStr = state.output
      ? String(state.output).slice(0, 2000) : undefined
    const errorStr = status === 'error' && state.error ? String(state.error) : undefined

    // Detect interactive question tools
    let questions: unknown = stateInput.questions
    if (typeof questions === 'string') {
      try { questions = JSON.parse(questions) } catch {}
    }
    // Detect TodoWrite tools
    let todos: unknown = stateInput.todos
    if (typeof todos === 'string') {
      try { todos = JSON.parse(todos) } catch {}
    }

    let partType = 'tool'
    if (Array.isArray(questions) && questions.length > 0) partType = 'question'
    else if (Array.isArray(todos) && todos.length > 0) partType = 'todowrite'

    return {
      id: part.id as string,
      type: partType as MessagePartType,
      text: part.text as string,
      content: part.text as string,
      tool: {
        name: toolName,
        status,
        title: (state.title as string) || undefined,
        input: inputStr,
        output: outputStr,
        error: errorStr,
        ...(Array.isArray(questions) && questions.length > 0 && { questions }),
        ...(Array.isArray(todos) && todos.length > 0 && { todos })
      },
      state: part.state as MessagePart['state']
    }
  }

  async pollMessages(
    sessionId: string,
    seenMessageIds: Set<string>,
    seenPartIds: Set<string>,
    partContentLengths: Map<string, string>,
    config: SessionConfig
  ): Promise<MessagePart[]> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) {
      return []
    }

    const messagesResult = await ocClient.session.messages({
      path: { id: sessionId },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (!messagesResult.data || !Array.isArray(messagesResult.data)) {
      return []
    }

    const newParts: MessagePart[] = []

    for (const msg of messagesResult.data) {
      if (!msg.info) continue
      const msgId = msg.info.id
      const msgRole = msg.info.role // Get role from message

      // Skip if already seen and no parts have changed
      const isNewMessage = !seenMessageIds.has(msgId)
      if (isNewMessage) {
        seenMessageIds.add(msgId)
      }

      const parts = msg.parts && Array.isArray(msg.parts) ? msg.parts : []
      for (const part of parts) {
        const partId = part.id
        if (!partId) continue
        // Cast part to a loose record for uniform property access across SDK Part union members
        const p = part as unknown as Record<string, unknown>

        const isNewPart = !seenPartIds.has(partId)
        const isUpdatable = part.type === 'text' || part.type === 'reasoning' || part.type === 'tool'

        if (isUpdatable) {
          const fingerprint = part.type === 'tool'
            ? `${(p.state as Record<string, unknown> | undefined)?.status}:${part.type}:${(p.text as string | undefined)?.length ?? 0}:${((p.state as Record<string, unknown> | undefined)?.output as string | undefined)?.length ?? 0}`
            : String((p.text as string | undefined)?.length ?? 0)

          const oldFingerprint = partContentLengths.get(partId)
          const hasChanged = oldFingerprint !== fingerprint

          if (isNewPart || hasChanged) {
            seenPartIds.add(partId)
            partContentLengths.set(partId, fingerprint)

            if (part.type === 'tool') {
              const transformed = this.transformToolPart(p)
              newParts.push({ ...transformed, role: msgRole, update: !isNewPart })
            } else {
              newParts.push({
                id: partId,
                type: part.type as unknown as MessagePartType,
                text: p.text as string,
                content: p.text as string,
                role: msgRole,
                update: !isNewPart
              })
            }
          }
        } else if (isNewPart) {
          seenPartIds.add(partId)
          newParts.push({
            id: partId,
            type: part.type as unknown as MessagePartType,
            text: p.text as string,
            content: p.text as string,
            role: msgRole // Include role from message
          })
        }
      }
    }

    return newParts
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const abort = this.promptAborts.get(sessionId)
    if (abort) {
      abort.abort()
      this.promptAborts.delete(sessionId)
    }
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    await this.abortPrompt(sessionId, _config)
    this.clients.delete(sessionId)

    // Clean up secret files (plugin + exports)
    for (const filePath of [this.pluginFilePath, this.secretsExportsPath]) {
      if (filePath) {
        try {
          if (existsSync(filePath)) {
            rmSync(filePath)
            console.log(`[OpencodeAdapter] Removed secret file: ${filePath}`)
          }
        } catch (err) {
          console.warn(`[OpencodeAdapter] Failed to remove secret file: ${err}`)
        }
      }
    }
    this.pluginFilePath = null
    this.secretsExportsPath = null
  }

  /**
   * Writes two files for secret injection:
   * 1. `.opencode/.20x-secrets` — pre-formatted export commands (read dynamically by the plugin)
   * 2. `.opencode/plugins/20x-secret-injector.js` — plugin using `tool.execute.before`
   *
   * The plugin reads the exports file on every bash command, so secrets can be
   * updated without restarting the server. Both files are cleaned up on session destroy.
   *
   * MUST be called BEFORE ensureServerRunning() so the plugin is discovered at startup.
   */
  private writeSecretFiles(config: SessionConfig): void {
    const secretCount = config.secretEnvVars ? Object.keys(config.secretEnvVars).length : 0
    console.log(`[OpencodeAdapter] writeSecretFiles: workspaceDir=${config.workspaceDir}, secretCount=${secretCount}`)
    if (!config.secretEnvVars || secretCount === 0 || !config.workspaceDir) {
      console.log(`[OpencodeAdapter] writeSecretFiles: skipping — no secrets or no workspaceDir`)
      return
    }

    const openCodeDir = join(config.workspaceDir, '.opencode')
    const pluginsDir = join(openCodeDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })

    // 1. Write pre-formatted export commands to a secrets file.
    //    The plugin reads this file on every bash invocation so updates take effect immediately.
    const exportLines = Object.entries(config.secretEnvVars)
      .map(([k, v]) => 'export ' + k + "='" + v.replace(/'/g, "'\\''" ) + "'")
      .join('\n')

    const secretsPath = join(openCodeDir, '.20x-secrets')
    writeFileSync(secretsPath, exportLines, 'utf-8')
    this.secretsExportsPath = secretsPath

    // 2. Write the plugin JS that reads the secrets file and prepends exports to bash commands.
    //    Uses tool.execute.before hook (same pattern as Claude Code PreToolUse).
    const pluginPath = join(pluginsDir, '20x-secret-injector.js')
    const pluginCode =
      '// Auto-generated by 20x — do not edit. Removed on session destroy.\n' +
      'import { readFileSync } from "fs";\n' +
      '\n' +
      'var SECRETS_PATH = ' + JSON.stringify(secretsPath) + ';\n' +
      '\n' +
      'export var SecretInjector = async function() {\n' +
      '  return {\n' +
      '    "tool.execute.before": async function(input, output) {\n' +
      '      if (input.tool === "bash") {\n' +
      '        try {\n' +
      '          var exports = readFileSync(SECRETS_PATH, "utf-8").trim();\n' +
      '          if (exports) output.args.command = exports + "\\n" + output.args.command;\n' +
      '        } catch(e) {}\n' +
      '      }\n' +
      '    }\n' +
      '  };\n' +
      '};\n'

    writeFileSync(pluginPath, pluginCode, 'utf-8')
    this.pluginFilePath = pluginPath

    console.log(`[OpencodeAdapter] Wrote secret files: plugin=${pluginPath}, secrets=${secretsPath} (${Object.keys(config.secretEnvVars).length} secret(s))`)
  }

  async getAllMessages(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) {
      return []
    }

    try {
      // Fetch all messages from OpenCode API
      const messagesResult = await ocClient.session.messages({
        path: { id: sessionId },
        ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
      })

      if (!messagesResult.data || !Array.isArray(messagesResult.data)) {
        return []
      }

      console.log(`[OpencodeAdapter] getAllMessages: Retrieved ${messagesResult.data.length} messages`)

      // Convert OpenCode messages to SessionMessage format
      const messages = messagesResult.data.map((msg: Record<string, unknown>, idx: number) => {
        const msgInfo = msg.info as Record<string, unknown> | undefined
        const role = (msgInfo?.role as string) || 'assistant'
        const parts = (msg.parts || []) as Record<string, unknown>[]

        // Log raw parts for debugging
        console.log(`[OpencodeAdapter] Message ${idx} role=${role}, parts count=${parts.length}`)
        parts.forEach((p: Record<string, unknown>, pIdx: number) => {
          const pText = p.text as string | undefined
          console.log(`[OpencodeAdapter]   Part ${pIdx}:`, {
            type: p.type,
            hasText: !!pText,
            textLength: pText?.length,
            textPreview: pText?.slice(0, 100)
          })
        })

        return {
          id: (msgInfo?.id as string) || `msg-${idx}`,
          role: (role === 'user' ? MessageRole.USER : MessageRole.ASSISTANT) as MessageRole,
          parts: parts.map((p: Record<string, unknown>) => ({
            id: p.id as string,
            type: (p.type as string) as unknown as MessagePartType,
            text: p.text as string,
            content: p.text as string
          }))
        }
      })

      return messages
    } catch (error) {
      console.error('[OpencodeAdapter] Error fetching messages:', error)
      return []
    }
  }

  async registerMcpServer(
    _serverName: string,
    _mcpConfig: {
      type: 'local' | 'remote'
      command?: string[]
      url?: string
      headers?: Record<string, string>
      environment?: Record<string, string>
    },
    _workspaceDir?: string
  ): Promise<void> {
    // This needs to be called before session creation
    // We need access to the ocClient, which we don't have yet
    // For now, this will be handled in the AgentManager until we refactor further
    throw new Error('registerMcpServer must be called via AgentManager for now')
  }

  private getV2Client(config: SessionConfig): V2OpencodeClient {
    if (this.v2Client) return this.v2Client
    if (!OpenCodeV2) throw new Error('OpenCode V2 SDK not loaded')

    const baseUrl = this.serverUrl || config.serverUrl || DEFAULT_SERVER_URL
    this.v2Client = OpenCodeV2.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch as unknown as typeof fetch })
    return this.v2Client
  }

  async respondToQuestion(
    sessionId: string,
    answers: Record<string, string>,
    config: SessionConfig
  ): Promise<void> {
    const v2 = this.getV2Client(config)

    try {
      // List pending questions via V2 SDK
      const listResult = await v2.question.list({
        ...(config.workspaceDir && { directory: config.workspaceDir })
      })

      if (listResult.error) {
        throw new Error(`question.list failed: ${JSON.stringify(listResult.error)}`)
      }

      const questions: V2QuestionRequest[] = listResult.data ?? []
      console.log(`[OpencodeAdapter] Pending questions (${questions.length}):`, questions.map(q => ({ id: q.id, sessionID: q.sessionID, questionCount: q.questions?.length })))

      // Find the question for this session
      const question = questions.find(q => q.sessionID === sessionId)
      if (!question?.id) {
        console.warn(`[OpencodeAdapter] No pending question found for session ${sessionId}`)
        return
      }

      console.log(`[OpencodeAdapter] Matched question:`, JSON.stringify(question, null, 2).slice(0, 1000))

      // Build answers aligned with the question's questions array order
      const questionItems = question.questions ?? []
      const answerKeys = Object.keys(answers)
      const formattedAnswers: string[][] = []

      for (let i = 0; i < questionItems.length; i++) {
        const qItem = questionItems[i]
        const matchKey = answerKeys.find(k => k === qItem.header || k === qItem.question)
        const answerValue = matchKey ? answers[matchKey] : Object.values(answers)[i]
        formattedAnswers.push(answerValue ? [answerValue] : [])
      }

      console.log(`[OpencodeAdapter] Replying to question ${question.id} (${questionItems.length} items) with:`, formattedAnswers)

      // Reply via V2 SDK
      const replyResult = await v2.question.reply({
        requestID: question.id,
        answers: formattedAnswers,
        ...(config.workspaceDir && { directory: config.workspaceDir })
      })

      if (replyResult.error) {
        throw new Error(`question.reply failed: ${JSON.stringify(replyResult.error)}`)
      }

      console.log(`[OpencodeAdapter] Question ${question.id} replied successfully`)
    } catch (err) {
      console.error('[OpencodeAdapter] Question API failed:', err)
    }
  }

  async stopServer(): Promise<void> {
    if (this.serverInstance) {
      try {
        await (this.serverInstance as { close: () => Promise<void> }).close()
      } catch (error) {
        console.error('[OpencodeAdapter] Error stopping server:', error)
      }
      this.serverInstance = null
      this.serverUrl = null
    }
  }
}
