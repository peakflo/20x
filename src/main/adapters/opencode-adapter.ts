import { Agent as UndiciAgent } from 'undici'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join, delimiter } from 'path'
import { homedir } from 'os'
import { buildMergedOpencodeConfig } from '../utils/opencode-config'
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
type OpenCodeV2Module = typeof import('@opencode-ai/sdk/v2')
type V2ClientModule = typeof import('@opencode-ai/sdk/v2/client')
type V2OpencodeClient = import('@opencode-ai/sdk/v2/client').OpencodeClient
type V2QuestionRequest = import('@opencode-ai/sdk/v2/client').QuestionRequest
let OpenCodeV2: OpenCodeV2Module | null = null
let OpenCodeV2Client: V2ClientModule | null = null

// Custom fetch with no timeout — agent prompts can run indefinitely
const noTimeoutAgent = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 })
const noTimeoutFetch = (req: unknown) => (globalThis as unknown as Record<string, (...args: unknown[]) => unknown>).fetch(req, { dispatcher: noTimeoutAgent })

const DEFAULT_SERVER_URL = 'http://localhost:4096'

/**
 * Adapter for OpenCode backend
 */
export class OpencodeAdapter implements CodingAgentAdapter {
  /** Callback set by agent-manager to trigger an immediate poll cycle */
  onDataAvailable?: (sessionId: string) => void
  private sdkLoading: Promise<void> | null = null
  private serverInstance: unknown = null
  private serverUrl: string | null = null
  private serverStarting: Promise<void> | null = null
  /** The shared V2 SDK client created alongside the server via createOpencode */
  private sharedClient: V2OpencodeClient | null = null
  private clients: Map<string, OpencodeClient> = new Map() // sessionId -> ocClient
  private v2Client: V2OpencodeClient | null = null
  private promptAborts: Map<string, AbortController> = new Map()
  /** Provider errors captured from prompt results (surfaced via getStatus) */
  private promptErrors: Map<string, string> = new Map()
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
      OpenCodeV2 = await import('@opencode-ai/sdk/v2')
      OpenCodeV2Client = await import('@opencode-ai/sdk/v2/client')
      console.log('[OpencodeAdapter] SDK loaded successfully (v2 available)')
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

  /**
   * Wait for a group of MCP servers to reach a terminal state.
   * Uses one status query per retry cycle (batched) instead of polling per server.
   */
  private async waitForMcpServersReady(
    ocClient: OpencodeClient,
    serverNames: string[],
    workspaceDir?: string,
    maxAttempts = 5,
    delayMs = 300
  ): Promise<Map<string, 'connected' | 'failed' | 'timeout'>> {
    const pending = new Set(serverNames)
    const states = new Map<string, 'connected' | 'failed' | 'timeout'>()

    for (let attempt = 0; attempt < maxAttempts && pending.size > 0; attempt++) {
      try {
        const statusMap = await this.getMcpStatusMap(ocClient, workspaceDir)

        for (const name of [...pending]) {
          const serverStatus = statusMap?.[name]
          if (!serverStatus?.status) continue

          if (serverStatus.status === 'connected') {
            states.set(name, 'connected')
            pending.delete(name)
            console.log(`[OpencodeAdapter] MCP server '${name}' status: connected (attempt ${attempt + 1})`)
          } else if (serverStatus.status === 'failed') {
            states.set(name, 'failed')
            pending.delete(name)
            console.error(`[OpencodeAdapter] MCP server '${name}' status: failed${serverStatus.error ? ` - ${serverStatus.error}` : ''}`)
          }
        }
      } catch (statusErr) {
        console.warn('[OpencodeAdapter] Failed to query MCP status:', statusErr)
      }

      if (pending.size > 0 && attempt < maxAttempts - 1 && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }

    for (const name of pending) {
      states.set(name, 'timeout')
    }

    return states
  }

  /**
   * Query MCP status via SDK.
   * Prefer mcp.list() (same view as `opencode mcp list`), fall back to mcp.status().
   */
  private async getMcpStatusMap(
    ocClient: OpencodeClient,
    workspaceDir?: string
  ): Promise<Record<string, { status?: string; error?: string }> | undefined> {
    const query = workspaceDir ? { query: { directory: workspaceDir } } : {}
    const mcpClient = ocClient.mcp as unknown as {
      list?: (args?: unknown) => Promise<{ data?: unknown; error?: unknown }>
      status: (args?: unknown) => Promise<{ data?: unknown; error?: unknown }>
    }

    if (typeof mcpClient.list === 'function') {
      try {
        const listResult = await mcpClient.list(query)
        if (!listResult.error) {
          const parsed = this.parseMcpListData(listResult.data)
          if (parsed) return parsed
        }
      } catch (err) {
        console.warn('[OpencodeAdapter] mcp.list failed, falling back to mcp.status:', err)
      }
    }

    const statusResult = await mcpClient.status(query)
    return statusResult.data as Record<string, { status?: string; error?: string }> | undefined
  }

  private parseMcpListData(
    data: unknown
  ): Record<string, { status?: string; error?: string }> | undefined {
    if (!data) return undefined

    if (Array.isArray(data)) {
      const out: Record<string, { status?: string; error?: string }> = {}
      for (const item of data) {
        const rec = item as {
          name?: string
          id?: string
          status?: string
          state?: string
          error?: string
          auth?: { status?: string; error?: string }
        }
        const name = rec.name || rec.id
        if (!name) continue
        out[name] = {
          status: rec.status || rec.state || rec.auth?.status,
          error: rec.error || rec.auth?.error
        }
      }
      return Object.keys(out).length > 0 ? out : undefined
    }

    if (typeof data === 'object') {
      const obj = data as Record<string, { status?: string; state?: string; error?: string }>
      const out: Record<string, { status?: string; error?: string }> = {}
      for (const [name, value] of Object.entries(obj)) {
        out[name] = {
          status: value?.status || value?.state,
          error: value?.error
        }
      }
      return Object.keys(out).length > 0 ? out : undefined
    }

    return undefined
  }

  private getScopedPartId(messageId: string, rawPartId: string | undefined, fallbackIndex?: number): string | undefined {
    if (rawPartId) return `${messageId}:${rawPartId}`
    if (fallbackIndex !== undefined) return `${messageId}:part-${fallbackIndex}`
    return undefined
  }

  /**
   * Returns the shared SDK client, ensuring the server is running first.
   */
  private async getClient(serverUrl?: string): Promise<V2OpencodeClient> {
    const baseUrl = serverUrl || this.serverUrl || DEFAULT_SERVER_URL
    await this.ensureServerRunning(baseUrl)

    if (!this.sharedClient) {
      throw new Error('OpenCode client not available after server startup')
    }
    return this.sharedClient
  }

  async getProviders(
    serverUrl?: string,
    directory?: string
  ): Promise<{
    providers: { id: string; name: string; models: unknown; [key: string]: unknown }[]
    default: Record<string, string>
  } | null> {
    try {
      const client = await this.getClient(serverUrl)

      const result = await client.config.providers({
        ...(directory && { directory })
      })

      if (result.error) {
        console.log('[OpencodeAdapter] No providers configured on server')
        return null
      }

      const data = result.data as {
        providers?: { id: string; name: string; models: unknown; [key: string]: unknown }[]
        default?: Record<string, string>
      } | undefined

      console.log('[OpencodeAdapter] Found providers:', data?.providers?.map((p) => p.id))
      return data ? { providers: data.providers || [], default: data.default || {} } : null
    } catch (error: unknown) {
      console.log('[OpencodeAdapter] Could not get providers:', error instanceof Error ? error.message : error)
      return null
    }
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      const client = await this.getClient()
      const result = await client.global.health()

      if (result.error) {
        return { available: false, reason: 'Server not responding' }
      }

      const health = result.data as { healthy: boolean; version: string }
      console.log('[OpencodeAdapter] Health check OK, version:', health.version)
      return { available: true }
    } catch (error: unknown) {
      return { available: false, reason: error instanceof Error ? error.message : 'Server not accessible' }
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

  /**
   * Ensures common binary install paths (e.g. ~/.opencode/bin) are in PATH
   * so the SDK's createOpencode can find the `opencode` binary.
   */
  private ensureBinaryPaths(): void {
    const currentPath = process.env.PATH || ''
    const extraPaths = [
      join(homedir(), '.opencode', 'bin'),
      ...(process.platform === 'win32'
        ? [join(homedir(), 'AppData', 'Roaming', 'npm')]
        : ['/usr/local/bin']),
      join(homedir(), '.local', 'bin')
    ].filter(p => !currentPath.includes(p))

    if (extraPaths.length > 0) {
      process.env.PATH = [...extraPaths, currentPath].join(delimiter)
      console.log('[OpencodeAdapter] Added binary paths to PATH:', extraPaths)
    }
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

    // Ensure common binary install paths are in PATH so the SDK can find `opencode`
    this.ensureBinaryPaths()

    const isDefaultUrl = targetUrl === DEFAULT_SERVER_URL || targetUrl === 'http://127.0.0.1:4096'

    this.serverStarting = (async () => {
      try {
        const accessibleUrl = await this.findAccessibleServer(targetUrl)
        if (accessibleUrl) {
          this.serverUrl = accessibleUrl
          this.serverInstance = null
          // Create a V2 client for the existing server (has global.health())
          this.sharedClient = OpenCodeV2Client!.createOpencodeClient({
            baseUrl: accessibleUrl,
            fetch: noTimeoutFetch as unknown as typeof fetch
          })

          // Push merged config (with auth.json keys injected) to the running server
          // so custom providers like routerAI are properly authenticated.
          try {
            const mergedConfig = buildMergedOpencodeConfig()
            if (mergedConfig.provider) {
              const castConfig = mergedConfig as import('@opencode-ai/sdk/v2/client').Config
              // Try global config first, then per-directory config as fallback
              try {
                await this.sharedClient.global.config.update({ config: castConfig })
              } catch {
                await this.sharedClient.config.update({ config: castConfig })
              }
              console.log('[OpencodeAdapter] Pushed merged provider config to existing server')
            }
          } catch (err) {
            console.warn('[OpencodeAdapter] Failed to push config to existing server:', err)
          }

          return
        }

        if (!isDefaultUrl) {
          throw new Error(`OpenCode server not accessible at ${targetUrl}`)
        }

        // Use SDK's createOpencode (starts server + client together, per docs).
        // The SDK picks up opencode.json automatically; we pass a merged config
        // that injects auth.json API keys into custom provider options so
        // providers like routerAI are properly authenticated.
        const url = new URL(targetUrl)
        const hostname = url.hostname
        const port = parseInt(url.port || '4096', 10)

        const extraConfig: Record<string, unknown> = {}
        if (this.pluginFilePath) {
          extraConfig.plugin = [this.pluginFilePath]
          console.log(`[OpencodeAdapter] Passing plugin to server config: ${this.pluginFilePath}`)
        }
        const mergedConfig = buildMergedOpencodeConfig(extraConfig)

        console.log(`[OpencodeAdapter] Creating opencode instance at ${hostname}:${port} via SDK v2 createOpencode`)
        const { client, server } = await OpenCodeV2!.createOpencode({
          hostname,
          port,
          timeout: 10000,
          config: mergedConfig as import('@opencode-ai/sdk/v2/client').Config
        })

        this.serverInstance = server
        this.serverUrl = server.url
        this.sharedClient = client
        console.log(`[OpencodeAdapter] OpenCode instance created at ${server.url}`)
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
      const connectCandidates: string[] = []

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
            if (addStatus.status === 'connected') {
              console.log(`[OpencodeAdapter] Successfully registered MCP server: ${name} (connected via mcp.add)`)
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
          connectCandidates.push(name)
        } catch (mcpError) {
          console.error(`[OpencodeAdapter] Failed to register MCP server ${name}:`, mcpError)
        }
      }

      if (connectCandidates.length > 0) {
        const readiness = await this.waitForMcpServersReady(ocClient, connectCandidates, config.workspaceDir)
        for (const name of connectCandidates) {
          const state = readiness.get(name)
          if (state === 'connected') {
            console.log(`[OpencodeAdapter] Successfully registered MCP server: ${name}`)
          } else if (state === 'failed') {
            console.error(`[OpencodeAdapter] MCP server '${name}' failed to connect`)
          } else {
            console.error(`[OpencodeAdapter] MCP server '${name}' did not reach connected status — tools may not work`)
          }
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
        const transformedParts: MessagePart[] = rawParts.map((part: Record<string, unknown>, partIndex: number) => {
          const scopedPartId = this.getScopedPartId(String(msg.info.id), part.id as string | undefined, partIndex)
          if (part.type === 'tool') {
            return {
              ...this.transformToolPart(part),
              id: scopedPartId
            }
          }
          return {
            id: scopedPartId,
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
    console.log(`[OpencodeAdapter] sendPrompt: sessionId=${sessionId}, partsCount=${parts.length}, model=${config.model ?? 'default'}, workspaceDir=${config.workspaceDir ?? 'none'}`)
    ocClient.session.prompt({
      path: { id: sessionId },
      body: {
        parts: parts as unknown as Array<import('@opencode-ai/sdk').TextPartInput>,
        ...(modelParam && { model: modelParam }),
        ...(config.tools && { tools: config.tools })
      },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } }),
      signal: promptAbort.signal
    }).then((result: unknown) => {
      console.log(`[OpencodeAdapter] prompt resolved: sessionId=${sessionId}, result=${JSON.stringify(result).slice(0, 500)}`)
      // Check for provider errors in the prompt response (e.g. quota exceeded,
      // payment required, rate limit).  OpenCode wraps these in result.data.info.error
      // but does NOT create a message with the error text, so pollMessages never
      // picks them up and the user sees "idle" with no response.
      const r = result as { data?: { info?: { error?: { name?: string; data?: { message?: string } } } } } | undefined
      const promptError = r?.data?.info?.error
      if (promptError) {
        const errorMsg = promptError.data?.message || promptError.name || 'Unknown provider error'
        console.error(`[OpencodeAdapter] prompt returned provider error: sessionId=${sessionId}, error=${errorMsg}`)
        this.promptErrors.set(sessionId, errorMsg)
        // Nudge the polling coordinator so the error is surfaced immediately
        if (this.onDataAvailable) {
          this.onDataAvailable(sessionId)
        }
      }
    }).catch((err: unknown) => {
      if (!(err instanceof Error) || err.name !== 'AbortError') {
        console.error('[OpencodeAdapter] prompt error:', err)
      } else {
        console.log(`[OpencodeAdapter] prompt aborted: sessionId=${sessionId}`)
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
      console.log(`[OpencodeAdapter] getStatus: sessionId=${sessionId}, statusResult.data is empty → IDLE`)
      // Check for captured prompt error before returning IDLE
      const promptError = this.promptErrors.get(sessionId)
      if (promptError) {
        this.promptErrors.delete(sessionId)
        console.log(`[OpencodeAdapter] getStatus: surfacing captured prompt error for ${sessionId}: ${promptError}`)
        return { type: SessionStatusType.ERROR, message: promptError }
      }
      return { type: SessionStatusType.IDLE }
    }

    const ocStatus = statusResult.data[sessionId]
    if (!ocStatus) {
      console.log(`[OpencodeAdapter] getStatus: sessionId=${sessionId}, no entry in statusResult.data (keys: ${Object.keys(statusResult.data).join(', ')}) → IDLE`)
      // Check for captured prompt error before returning IDLE
      const promptError = this.promptErrors.get(sessionId)
      if (promptError) {
        this.promptErrors.delete(sessionId)
        console.log(`[OpencodeAdapter] getStatus: surfacing captured prompt error for ${sessionId}: ${promptError}`)
        return { type: SessionStatusType.ERROR, message: promptError }
      }
      return { type: SessionStatusType.IDLE }
    }

    const sdkType = (ocStatus.type || 'idle') as string
    console.log(`[OpencodeAdapter] getStatus: sessionId=${sessionId}, sdkType=${sdkType}, raw=${JSON.stringify(ocStatus).slice(0, 300)}`)
    if (sdkType === 'waiting_approval' || sdkType === 'waiting_input' || sdkType === 'waiting_user') {
      return { type: SessionStatusType.WAITING_APPROVAL }
    }

    // Check for pending questions via V2 SDK
    try {
      const v2 = this.getV2Client(config)
      const listResult = await v2.question.list({
        ...(config.workspaceDir && { directory: config.workspaceDir })
      })
      if (!listResult.error && listResult.data) {
        const questions = listResult.data as Array<Record<string, unknown>>
        const targetQuestion = questions.find((q) => (q.sessionID as string | undefined) === sessionId || (q.sessionId as string | undefined) === sessionId)
        if (targetQuestion?.id) {
          return { type: SessionStatusType.WAITING_APPROVAL }
        }
      }
    } catch {
      // Ignore errors when checking for questions
    }

    const statusType = sdkType.toUpperCase() as keyof typeof SessionStatusType
    const resolvedType = SessionStatusType[statusType] ?? SessionStatusType.IDLE

    // If the backend reports IDLE but we captured a provider error from the
    // prompt result, surface it as ERROR so the agent-manager shows it in the UI.
    if (resolvedType === SessionStatusType.IDLE) {
      const promptError = this.promptErrors.get(sessionId)
      if (promptError) {
        this.promptErrors.delete(sessionId)
        console.log(`[OpencodeAdapter] getStatus: surfacing captured prompt error for ${sessionId}: ${promptError}`)
        return { type: SessionStatusType.ERROR, message: promptError }
      }
    }

    return {
      type: resolvedType,
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
      console.log(`[OpencodeAdapter] pollMessages: sessionId=${sessionId}, no data returned`)
      return []
    }

    console.log(`[OpencodeAdapter] pollMessages: sessionId=${sessionId}, totalMessages=${messagesResult.data.length}, seenMsgIds=${seenMessageIds.size}, seenPartIds=${seenPartIds.size}`)
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
        const partId = this.getScopedPartId(String(msgId), part.id as string | undefined)
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
              newParts.push({ ...transformed, id: partId, role: msgRole, update: !isNewPart })
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

    if (newParts.length > 0) {
      console.log(`[OpencodeAdapter] pollMessages: sessionId=${sessionId}, newParts=${newParts.length}, roles=[${newParts.map(p => p.role).join(',')}], types=[${newParts.map(p => p.type).join(',')}], updates=[${newParts.map(p => (p as Record<string, unknown>).update ?? false).join(',')}]`)
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

      // Convert OpenCode messages to SessionMessage format
      const messages = messagesResult.data.map((msg: Record<string, unknown>, idx: number) => {
        const msgInfo = msg.info as Record<string, unknown> | undefined
        const role = (msgInfo?.role as string) || 'assistant'
        const parts = (msg.parts || []) as Record<string, unknown>[]

        return {
          id: (msgInfo?.id as string) || `msg-${idx}`,
          role: (role === 'user' ? MessageRole.USER : MessageRole.ASSISTANT) as MessageRole,
          parts: parts.map((p: Record<string, unknown>, partIndex: number) => ({
            id: this.getScopedPartId(String((msgInfo?.id as string) || `msg-${idx}`), p.id as string | undefined, partIndex),
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
    if (!OpenCodeV2Client) throw new Error('OpenCode V2 SDK not loaded')

    const baseUrl = this.serverUrl || config.serverUrl || DEFAULT_SERVER_URL
    this.v2Client = OpenCodeV2Client.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch as unknown as typeof fetch })
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
      console.log(
        `[OpencodeAdapter] Pending questions (${questions.length}):`,
        questions.map(q => ({
          id: q.id,
          sessionID: q.sessionID,
          sessionId: (q as unknown as { sessionId?: string }).sessionId,
          questionCount: q.questions?.length
        }))
      )

      // Find the question for this session
      const question = questions.find(q => q.sessionID === sessionId || (q as unknown as { sessionId?: string }).sessionId === sessionId)
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
      this.sharedClient = null
      this.v2Client = null
    }
  }
}
