import { Agent as UndiciAgent } from 'undici'
import { mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync, readFileSync } from 'fs'
import { join, delimiter } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { buildMergedOpencodeConfig } from '../utils/opencode-config'
import { ENTERPRISE_AI_GATEWAY_PROVIDER_ID, readEnterpriseAiGatewayConfig } from '../enterprise-ai-gateway'
import type { DatabaseManager } from '../database'
import type {
  CodingAgentAdapter,
  McpServerConfig,
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

// Custom fetch with no timeout — used ONLY for session.prompt() which stays open
// for the entire agent loop (including all tool calls). All other SDK calls use the
// default fetch which has the SDK's built-in 60s timeout.
const noTimeoutAgent = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 })
const noTimeoutFetch = (req: unknown) => (globalThis as unknown as Record<string, (...args: unknown[]) => unknown>).fetch(req, { dispatcher: noTimeoutAgent })

// Fetch with reasonable timeout for quick operations (health checks, config queries, provider listing)
const QUICK_OP_TIMEOUT_MS = 15_000
const quickTimeoutAgent = new UndiciAgent({ headersTimeout: QUICK_OP_TIMEOUT_MS, bodyTimeout: QUICK_OP_TIMEOUT_MS })
const quickTimeoutFetch = (req: unknown) => (globalThis as unknown as Record<string, (...args: unknown[]) => unknown>).fetch(req, { dispatcher: quickTimeoutAgent })

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
  /** A separate V2 client with a reasonable timeout for quick operations (config, providers, health) */
  private quickClient: V2OpencodeClient | null = null
  private clients: Map<string, OpencodeClient> = new Map() // sessionId -> ocClient (default timeout, for polling/status/create)
  /** Separate clients with no timeout, used ONLY for session.prompt() which runs indefinitely */
  private promptClients: Map<string, OpencodeClient> = new Map()
  private v2Client: V2OpencodeClient | null = null
  private promptAborts: Map<string, AbortController> = new Map()
  /** Provider errors captured from prompt results (surfaced via getStatus) */
  private promptErrors: Map<string, string> = new Map()
  /** Absolute paths to generated OpenCode plugin files registered for this session/workspace */
  private pluginFilePaths: string[] = []
  /** Absolute paths to generated support files used by runtime plugins */
  private runtimeSupportFilePaths: string[] = []
  /** Absolute path to the generated tillDone config support file */
  private tillDoneConfigPath: string | null = null
  /** Whether the merged config has been pushed at least once to the running server.
   *  Config is pushed once on first server connection; subsequent pushes happen only
   *  via explicit `notifyConfigChanged()` calls (e.g. after settings edit or key rotation).
   *  This avoids PATCH /global/config storms that abort all running sessions. */
  private configPushed = false
  /** Maximum number of automatic retries for transient prompt errors (e.g. "Aborted") */
  private static readonly PROMPT_MAX_RETRIES = 3
  /** Base delay (ms) for exponential backoff between prompt retries */
  private static readonly PROMPT_RETRY_BASE_DELAY_MS = 2_000
  /** Pending permission requests per session (captured from SSE events).
   *  Each session may have multiple pending permissions (parallel tool calls). */
  private pendingPermissions: Map<string, Array<{ permissionId: string; permission: string; patterns: string[] }>> = new Map()
  /** Abort controller for the SSE event subscription */
  private sseAbort: AbortController | null = null
  /** Per-session permission mode ('ask' = surface in UI, 'allow' = auto-approve) */
  private sessionPermissionModes: Map<string, 'ask' | 'allow'> = new Map()
  /** Per-session workspace directory — needed for permission replies and other
   *  session-scoped V2 API calls initiated from global SSE events. */
  private sessionWorkspaceDirs: Map<string, string> = new Map()
  /** Per-session MCP server configs — retained for re-registration on session resume
   *  (e.g. after 20x restart when stdio MCP server processes are dead). */
  private sessionMcpConfigs: Map<string, Record<string, { type: string; url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> }>> = new Map()

  constructor(private db?: Pick<DatabaseManager, 'getSetting'>) {
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

  /**
   * Register MCP servers with the OpenCode backend (mcp.add + mcp.connect).
   * Called from both createSession (initial setup) and resumeSession (after 20x
   * restart when stdio MCP server processes are dead and need re-registration).
   */
  private async registerMcpServers(
    ocClient: OpencodeClient,
    mcpServers: Record<string, McpServerConfig>,
    workspaceDir?: string
  ): Promise<void> {
    const connectCandidates: string[] = []

    for (const [name, mcpConfig] of Object.entries(mcpServers)) {
      try {
        const mcpAddConfig = mcpConfig.type === 'http'
          ? { type: 'remote' as const, url: mcpConfig.url ?? '', headers: mcpConfig.headers }
          : { type: 'local' as const, command: [mcpConfig.command ?? '', ...(mcpConfig.args ?? [])], environment: mcpConfig.env }
        console.log(`[OpencodeAdapter] Registering MCP server: ${name}`, JSON.stringify(mcpAddConfig))

        // Add MCP server
        const addResult = await ocClient.mcp.add({
          body: { name, config: mcpAddConfig },
          ...(workspaceDir && { query: { directory: workspaceDir } })
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
          ...(workspaceDir && { query: { directory: workspaceDir } })
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
      const readiness = await this.waitForMcpServersReady(ocClient, connectCandidates, workspaceDir)
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

  private getScopedPartId(messageId: string, rawPartId: string | undefined, fallbackIndex?: number): string | undefined {
    if (rawPartId) return `${messageId}:${rawPartId}`
    if (fallbackIndex !== undefined) return `${messageId}:part-${fallbackIndex}`
    return undefined
  }

  /**
   * Returns the shared SDK client, ensuring the server is running first.
   * Pass `quick: true` to get a client with a bounded timeout (for config queries, health checks).
   */
  private async getClient(serverUrl?: string, opts?: { quick?: boolean }): Promise<V2OpencodeClient> {
    const baseUrl = serverUrl || this.serverUrl || DEFAULT_SERVER_URL
    await this.ensureServerRunning(baseUrl)

    if (opts?.quick) {
      if (!this.quickClient) {
        throw new Error('OpenCode quick client not available after server startup')
      }
      return this.quickClient
    }

    if (!this.sharedClient) {
      throw new Error('OpenCode client not available after server startup')
    }
    return this.sharedClient
  }

  /**
   * Push the merged provider/auth config to the running OpenCode server.
   *
   * ⚠️  PATCH /global/config causes the server to call disposeAllInstancesAndEmitGlobalDisposed(),
   * which aborts every running session processor AND disconnects all MCP servers.
   *
   * Strategy:
   *   - When sessions are active: push via directory-scoped PATCH /config for each
   *     active session directory. This updates the config without killing MCP connections.
   *   - When no sessions are active: safe to use global endpoint.
   */
  private async pushMergedConfigToClient(client: V2OpencodeClient): Promise<void> {
    const hasActivePrompts = this.promptAborts.size > 0

    try {
      const mergedConfig = buildMergedOpencodeConfig(undefined, this.db)
      if (!mergedConfig.provider) {
        console.log('[OpencodeAdapter] pushMergedConfigToClient: no providers in merged config, skipping')
        return
      }

      const providerIds = Object.keys(mergedConfig.provider as Record<string, unknown>)
      console.log('[OpencodeAdapter] pushMergedConfigToClient: pushing providers:', providerIds.join(', '))

      const castConfig = mergedConfig as import('@opencode-ai/sdk/v2/client').Config

      if (hasActivePrompts) {
        // Sessions are running — use directory-scoped config updates to avoid
        // disposeAllInstances which would kill MCP connections.
        console.log(`[OpencodeAdapter] pushMergedConfigToClient: ${this.promptAborts.size} prompt(s) active — using directory-scoped config push`)
        const directories = new Set(this.sessionWorkspaceDirs.values())
        if (directories.size > 0) {
          for (const dir of directories) {
            try {
              await client.config.update({ config: castConfig, directory: dir })
            } catch {
              // Individual directory push failed — non-fatal
            }
          }
        } else {
          // No directories known — fall back to global as last resort
          console.warn('[OpencodeAdapter] pushMergedConfigToClient: no known directories, using global endpoint (may disrupt active sessions)')
          await client.global.config.update({ config: castConfig })
        }
      } else {
        // No active sessions — safe to use global endpoint
        try {
          const result = await client.global.config.update({ config: castConfig })
          if (result.error) {
            console.warn('[OpencodeAdapter] global.config.update returned error:', JSON.stringify(result.error))
            throw new Error('global.config.update returned error')
          }
        } catch {
          const result = await client.config.update({ config: castConfig })
          if (result.error) {
            console.warn('[OpencodeAdapter] config.update returned error:', JSON.stringify(result.error))
          }
        }
      }
      this.configPushed = true
    } catch (err) {
      console.warn('[OpencodeAdapter] pushMergedConfigToClient failed:', err instanceof Error ? err.message : err)
    }
  }

  /**
   * Notify the adapter that provider config has changed (e.g. user edited agent settings,
   * AI gateway key was rotated).  Pushes the updated config to the running server.
   *
   * Call this from the agent-manager when settings change — do NOT call it on every
   * createSession or getClient, since PATCH /global/config aborts all running sessions.
   */
  async notifyConfigChanged(): Promise<void> {
    if (!this.sharedClient) {
      console.log('[OpencodeAdapter] notifyConfigChanged: no server connection yet, skipping')
      return
    }
    console.log('[OpencodeAdapter] notifyConfigChanged: pushing updated config to server')
    await this.pushMergedConfigToClient(this.sharedClient)
  }

  async getProviders(
    serverUrl?: string,
    directory?: string
  ): Promise<{
    providers: { id: string; name: string; models: unknown; [key: string]: unknown }[]
    default: Record<string, string>
  } | null> {
    return this.getProvidersInner(serverUrl, directory, true)
  }

  private async getProvidersInner(
    serverUrl?: string,
    directory?: string,
    allowRecovery = true
  ): Promise<{
    providers: { id: string; name: string; models: unknown; [key: string]: unknown }[]
    default: Record<string, string>
  } | null> {
    try {
      const client = await this.getClient(serverUrl, { quick: true })

      // Push the merged config if it hasn't been pushed yet. This handles the
      // edge case where getProviders is called before any session has started
      // (e.g. the user opens settings immediately after app launch). Once config
      // has been pushed via ensureServerRunning, this is a no-op. Subsequent
      // config changes go through notifyConfigChanged().
      if (!this.configPushed) {
        await this.pushMergedConfigToClient(client)
      }

      // Always pass a writable directory so the OpenCode server doesn't fall
      // back to its CWD (which is read-only on macOS when launched from
      // /Applications). Without this, fromDirectory() in the server tries to
      // create an SQLite DB at the CWD and fails with "disk I/O error".
      const safeDirectory = directory || homedir()

      const result = await client.config.providers({
        directory: safeDirectory
      })

      if (result.error) {
        const errorStr = JSON.stringify(result.error)

        // Detect SQLite database errors from the server (corrupted DB, stale WAL
        // files, migration failures from opencode version upgrades).
        // Recovery: kill the stale server, clear its DB, reset state, retry once.
        if (allowRecovery && errorStr.includes('SQLiteError')) {
          console.warn('[OpencodeAdapter] SQLite error from server, attempting recovery:', errorStr)
          await this.recoverFromBrokenServer()
          return this.getProvidersInner(serverUrl, directory, false)
        }

        console.log('[OpencodeAdapter] No providers configured on server:', errorStr)
        return null
      }

      const data = result.data as {
        providers?: { id: string; name: string; models: unknown; [key: string]: unknown }[]
        default?: Record<string, string>
      } | undefined

      // Filter stale models from the enterprise AI gateway provider.
      // The OpenCode server uses PATCH (merge semantics) for config updates,
      // so models removed from LiteLLM persist in the server's config.
      // We apply a client-side filter using the fresh model list from SQLite
      // (which was just refreshed from LiteLLM by the caller in agent-manager).
      if (data?.providers && this.db) {
        this.filterStaleProviderModels(data.providers)
      }

      return data ? { providers: data.providers || [], default: data.default || {} } : null
    } catch (error: unknown) {
      console.log('[OpencodeAdapter] Could not get providers:', error instanceof Error ? error.message : error)
      return null
    }
  }

  /**
   * Remove models from the enterprise AI gateway provider that are no longer
   * present in the fresh config stored in SQLite. Mutates the providers array
   * in place.
   */
  private filterStaleProviderModels(
    providers: { id: string; name: string; models: unknown; [key: string]: unknown }[]
  ): void {
    if (!this.db) return

    const freshConfig = readEnterpriseAiGatewayConfig(this.db)
    if (!freshConfig?.models) return

    const freshModelIds = new Set(freshConfig.models.map(m => m.id))
    const provider = providers.find(p => p.id === ENTERPRISE_AI_GATEWAY_PROVIDER_ID)
    if (!provider?.models || typeof provider.models !== 'object') return

    const serverModels = provider.models as Record<string, unknown>
    const filtered: Record<string, unknown> = {}
    for (const [modelId, modelConfig] of Object.entries(serverModels)) {
      if (freshModelIds.has(modelId)) {
        filtered[modelId] = modelConfig
      }
    }

    const removed = Object.keys(serverModels).length - Object.keys(filtered).length
    if (removed > 0) {
      provider.models = filtered
      console.log(`[OpencodeAdapter] Filtered out ${removed} stale model(s) from ${ENTERPRISE_AI_GATEWAY_PROVIDER_ID} provider`)
    }
  }

  /**
   * Recover from a broken opencode server by killing it, clearing its
   * corrupted database, and resetting adapter state so the next call
   * spawns a fresh server.
   */
  private async recoverFromBrokenServer(): Promise<void> {
    console.log('[OpencodeAdapter] Starting recovery: stopping broken server and clearing database')

    // 1. Stop the server if we spawned it
    try {
      await this.stopServer()
    } catch {
      // Already logged in stopServer
    }

    // 2. Kill any opencode process on the default port (may be a leftover
    //    from a previous app launch or terminal session).
    try {
      if (process.platform === 'win32') {
        execSync('taskkill /F /IM opencode.exe 2>nul', { stdio: 'ignore' })
      } else {
        // Kill processes listening on port 4096 specifically
        execSync("lsof -ti :4096 | xargs kill -9 2>/dev/null || true", { stdio: 'ignore' })
      }
      console.log('[OpencodeAdapter] Killed opencode process on port 4096')
    } catch {
      // Process may already be gone
    }

    // 3. Clear the global database and WAL/SHM sidecar files.
    //    These can get corrupted after a crash or during opencode version upgrades.
    const dbDir = join(homedir(), '.local', 'share', 'opencode')
    const dbFiles = ['opencode.db', 'opencode.db-shm', 'opencode.db-wal']
    for (const file of dbFiles) {
      const filePath = join(dbDir, file)
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath)
          console.log(`[OpencodeAdapter] Deleted corrupted DB file: ${filePath}`)
        }
      } catch (err) {
        console.warn(`[OpencodeAdapter] Could not delete ${filePath}:`, err)
      }
    }

    // 4. Reset adapter state so the next getClient() call spawns a fresh server
    this.serverUrl = null
    this.serverInstance = null
    this.sharedClient = null
    this.quickClient = null
    this.v2Client = null
    this.serverStarting = null
    this.configPushed = false

    // Brief pause to let the OS release the port
    await new Promise(resolve => setTimeout(resolve, 500))

    console.log('[OpencodeAdapter] Recovery complete, will spawn fresh server on next call')
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      const client = await this.getClient(undefined, { quick: true })
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

    // Include user-configured custom binary path (set via deps:setOpencodePath
    // in onboarding). Without this the installer finds opencode but the adapter
    // cannot, because the custom path is only added to PATH during deps:check.
    const customPath = this.db?.getSetting('OPENCODE_BINARY_PATH') ?? null

    const extraPaths = [
      ...(customPath ? [customPath] : []),
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

    // Set bash tool timeout if not already configured.
    // Without this, bash commands inside the agent run indefinitely — a single
    // hung `npm install` or `git clone` will keep the session stuck forever.
    // 10 minutes is generous enough for legitimate long-running commands while
    // preventing truly stuck processes.
    if (!process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS) {
      process.env.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = '600000' // 10 minutes
      console.log('[OpencodeAdapter] Set OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS=600000 (10min)')
    }

    const isDefaultUrl = targetUrl === DEFAULT_SERVER_URL || targetUrl === 'http://127.0.0.1:4096'

    this.serverStarting = (async () => {
      try {
        const accessibleUrl = await this.findAccessibleServer(targetUrl)
        if (accessibleUrl) {
          this.serverUrl = accessibleUrl
          this.serverInstance = null
          // Create a V2 client for the existing server (has global.health())
          this.sharedClient = OpenCodeV2Client!.createOpencodeClient({
            baseUrl: accessibleUrl
          })
          // Create a separate client with bounded timeout for quick operations
          this.quickClient = OpenCodeV2Client!.createOpencodeClient({
            baseUrl: accessibleUrl,
            fetch: quickTimeoutFetch as unknown as typeof fetch
          })

          // Push merged config (with auth.json keys injected) once on first connection
          // so custom providers like routerAI are properly authenticated.
          // This is the ONLY automatic config push; subsequent pushes happen only via
          // explicit notifyConfigChanged() calls to avoid aborting running sessions.
          try {
            // Use quickClient to avoid hanging indefinitely when the existing server is slow.
            await this.pushMergedConfigToClient(this.quickClient!)
          } catch {
            // pushMergedConfigToClient already logs details
          }

          // Start SSE subscription for permission events
          this.startEventSubscription()
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
        if (this.pluginFilePaths.length > 0) {
          extraConfig.plugin = [...this.pluginFilePaths]
          console.log('[OpencodeAdapter] Passing plugins to server config:', this.pluginFilePaths)
        }
        const mergedConfig = buildMergedOpencodeConfig(extraConfig, this.db)

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
        // Create a separate client with bounded timeout for quick operations
        this.quickClient = OpenCodeV2Client!.createOpencodeClient({
          baseUrl: server.url,
          fetch: quickTimeoutFetch as unknown as typeof fetch
        })
        console.log(`[OpencodeAdapter] OpenCode instance created at ${server.url}`)
      } finally {
        this.serverStarting = null
        // Start SSE subscription for permission events once the server is up
        this.startEventSubscription()
      }
    })()

    return this.serverStarting
  }

  async createSession(config: SessionConfig): Promise<string> {
    // Write runtime plugin files BEFORE server starts so they are discovered at startup.
    // Plugins that depend on support files read them dynamically, so updates can take
    // effect without restarting the server.
    this.writeRuntimePluginFiles(config)

    await this.ensureServerRunning(config.serverUrl || DEFAULT_SERVER_URL)

    // Config is pushed once on first server connection (ensureServerRunning).
    // Subsequent config changes (key rotation, settings edit) go through
    // notifyConfigChanged() called by the agent-manager — NOT here.
    // Pushing config on every createSession caused a storm of PATCH /global/config
    // calls that aborted all running sessions when parallel tasks started.

    const baseUrl = this.serverUrl || config.serverUrl || DEFAULT_SERVER_URL
    // Default client uses SDK's built-in timeout (60s) for session create, polling, MCP ops, etc.
    const ocClient = OpenCodeSDK!.createOpencodeClient({ baseUrl })
    // Separate client with no timeout — used ONLY for session.prompt() which runs indefinitely
    const promptClient = OpenCodeSDK!.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch as unknown as (request: Request) => ReturnType<typeof fetch> })

    // Register runtime plugins via directory-scoped config.update().
    // Using the directory scope avoids side-effects on other sessions — unscoped
    // config patches can trigger disposeAllInstances on the OpenCode server,
    // which kills MCP connections for every running session.
    if (this.pluginFilePaths.length > 0) {
      try {
        await ocClient.config.update({
          body: { plugin: [...this.pluginFilePaths] } as Record<string, unknown>,
          ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
        })
        console.log('[OpencodeAdapter] Registered runtime plugins via config.update:', this.pluginFilePaths)
      } catch (err) {
        console.warn('[OpencodeAdapter] config.update for runtime plugins failed (will rely on startup loading):', err)
      }
    }

    // Register MCP servers BEFORE creating session so the session picks them up
    if (config.mcpServers) {
      await this.registerMcpServers(ocClient, config.mcpServers, config.workspaceDir)
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
    this.writeTillDoneSessionConfig(ocSessionId, config.tillDone !== false)
    this.clients.set(ocSessionId, ocClient)
    this.promptClients.set(ocSessionId, promptClient)
    this.sessionPermissionModes.set(ocSessionId, config.permissionMode || 'ask')
    if (config.workspaceDir) this.sessionWorkspaceDirs.set(ocSessionId, config.workspaceDir)
    if (config.mcpServers) this.sessionMcpConfigs.set(ocSessionId, config.mcpServers as Record<string, { type: string; url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> }>)

    return ocSessionId
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    // Update runtime plugin files before resuming (plugins read support files dynamically)
    this.writeRuntimePluginFiles(config)

    await this.ensureServerRunning(config.serverUrl || DEFAULT_SERVER_URL)

    const baseUrl = this.serverUrl || config.serverUrl || DEFAULT_SERVER_URL
    // Default client uses SDK's built-in timeout for polling/status
    const ocClient = OpenCodeSDK!.createOpencodeClient({ baseUrl })
    // Separate client with no timeout for session.prompt() only
    const promptClient = OpenCodeSDK!.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch as unknown as (request: Request) => ReturnType<typeof fetch> })

    // Register runtime plugins via directory-scoped config.update() to avoid
    // side-effects on other sessions (see createSession comment).
    if (this.pluginFilePaths.length > 0) {
      try {
        await ocClient.config.update({
          body: { plugin: [...this.pluginFilePaths] } as Record<string, unknown>,
          ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
        })
        console.log('[OpencodeAdapter] Registered runtime plugins via config.update:', this.pluginFilePaths)
      } catch (err) {
        console.warn('[OpencodeAdapter] config.update for runtime plugins failed:', err)
      }
    }

    // Re-register MCP servers — after a 20x restart, stdio MCP server
    // processes (task-management, GCP logs) are dead and need re-registration.
    // Remote MCP servers may also have lost their SSE connections.
    // OpenCode handles transient mid-session reconnections internally, so this
    // is only needed on resume, not during normal operation.
    if (config.mcpServers) {
      await this.registerMcpServers(ocClient, config.mcpServers, config.workspaceDir)
    }

    // Validate session exists
    const getResult = await ocClient.session.get({
      path: { id: sessionId },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (getResult.error || !getResult.data) {
      throw new Error('Session no longer exists on server')
    }

    // ── Clean up stale session state from previous app instance ──
    // When the app restarts and resumes a session, tool calls from the
    // previous instance may still be in "running" state.  The OpenCode
    // server reports these as "busy" even though nothing is actually
    // executing.  This blocks new prompts and aborts.
    //
    // Fix: abort any in-progress prompt, then delete zombie "running"
    // tool parts via V2 part.delete.
    try {
      await ocClient.session.abort({
        path: { id: sessionId },
        ...(config.workspaceDir && { query: { directory: config.workspaceDir } }),
      })
      console.log(`[OpencodeAdapter] Aborted any in-progress prompt on resume for session ${sessionId}`)
    } catch {
      // Non-fatal: session may already be idle
    }

    // Delete zombie "running" tool parts that survived the abort.
    // When a prompt is aborted, individual tool parts remain in
    // "running" state permanently.  The server counts them as active
    // work, so the session stays "busy" forever — a catch-22 that
    // prevents both new prompts and message deletion.
    // Using v2.part.delete is the only way to clear them.
    try {
      if (OpenCodeV2Client) {
        const v2 = this.v2Client || OpenCodeV2Client.createOpencodeClient({
          baseUrl: this.serverUrl || DEFAULT_SERVER_URL
        })
        if (!this.v2Client) this.v2Client = v2

        // Scan messages for zombie running tool parts
        const msgsResult = await ocClient.session.messages({
          path: { id: sessionId },
          ...(config.workspaceDir && { query: { directory: config.workspaceDir } }),
        })
        let zombieCount = 0
        if (msgsResult.data && Array.isArray(msgsResult.data)) {
          for (const msg of msgsResult.data) {
            const msgId = (msg as Record<string, unknown>).info
              ? ((msg as Record<string, unknown>).info as Record<string, unknown>).id as string
              : undefined
            if (!msgId) continue
            for (const part of ((msg as Record<string, unknown>).parts as Array<Record<string, unknown>>) || []) {
              if (part.type !== 'tool') continue
              const state = part.state as Record<string, unknown> | undefined
              if (state?.status !== 'running') continue

              try {
                await v2.part.delete({
                  sessionID: sessionId,
                  messageID: msgId,
                  partID: part.id as string,
                  ...(config.workspaceDir && { directory: config.workspaceDir }),
                })
                zombieCount++
              } catch {
                // Part may already have been cleaned up
              }
            }
          }
        }
        if (zombieCount > 0) {
          console.log(`[OpencodeAdapter] Deleted ${zombieCount} zombie running tool part(s) on resume for session ${sessionId}`)
          // Abort again after cleanup to transition the server from busy → idle
          try {
            await ocClient.session.abort({
              path: { id: sessionId },
              ...(config.workspaceDir && { query: { directory: config.workspaceDir } }),
            })
          } catch {
            // Non-fatal
          }
        }

        // Also clear any stale pending permissions
        const listResult = await v2.permission.list({})
        if (listResult.data && Array.isArray(listResult.data)) {
          const allPending = listResult.data as Array<{ id: string; sessionID: string }>
          const sessionPending = allPending.filter(p => p.sessionID === sessionId)
          for (const perm of sessionPending) {
            try {
              await v2.permission.reply({
                requestID: perm.id,
                reply: 'always'
              })
              console.log(`[OpencodeAdapter] Auto-approved stale permission ${perm.id} on resume`)
            } catch {
              // Permission may have already expired
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[OpencodeAdapter] Failed to clean up stale session state on resume:`, err instanceof Error ? err.message : err)
    }

    this.clients.set(sessionId, ocClient)
    this.promptClients.set(sessionId, promptClient)
    this.sessionPermissionModes.set(sessionId, config.permissionMode || 'ask')
    if (config.workspaceDir) this.sessionWorkspaceDirs.set(sessionId, config.workspaceDir)
    if (config.mcpServers) this.sessionMcpConfigs.set(sessionId, config.mcpServers as Record<string, { type: string; url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> }>)
    this.writeTillDoneSessionConfig(sessionId, config.tillDone !== false)

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

        // Surface provider errors stored in msg.info.error (e.g. "Payment
        // Required", quota exceeded).  OpenCode records these on the message
        // info but creates no parts for them, so without this they vanish on
        // resume.
        const msgError = (msg.info as Record<string, unknown>).error as { name?: string; data?: { message?: string } } | undefined
        if (msgError && transformedParts.length === 0) {
          const errorText = msgError.data?.message || msgError.name || 'Unknown provider error'
          transformedParts.push({
            id: `error-${msg.info.id}`,
            type: 'text' as unknown as MessagePartType,
            text: `⚠️ Provider error: ${errorText}`,
            content: `⚠️ Provider error: ${errorText}`
          })
        }

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
    // Use the no-timeout prompt client for session.prompt() which runs indefinitely.
    // Falls back to the default client if promptClients entry is missing (shouldn't happen).
    const ocClient = this.promptClients.get(sessionId) || this.clients.get(sessionId)
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

    // Fire-and-forget prompt with retry — the HTTP call stays open until the full
    // agent loop completes (including tool call execution).  getStatus() checks
    // promptAborts to reliably report BUSY while this call is in flight.
    // Retries handle transient "Aborted" errors caused by config pushes or
    // provider concurrency limits.
    console.log(`[OpencodeAdapter] Sending prompt for session ${sessionId} (model: ${config.model || 'default'})`)
    this.executePromptWithRetry(ocClient, sessionId, parts, modelParam, config, promptAbort)
      .finally(() => {
        this.promptAborts.delete(sessionId)
      })
  }

  /**
   * Returns true if the error message indicates a transient condition that
   * may succeed on retry (e.g. OpenCode server aborted the session processor
   * due to a config push, or the provider returned a temporary overload).
   */
  private isRetryablePromptError(msg: string): boolean {
    const lower = msg.toLowerCase()
    return lower === 'aborted' || lower.includes('aborted') || lower.includes('overloaded') || lower.includes('service unavailable')
  }

  /**
   * Executes a prompt with automatic retry for transient errors.
   * Keeps the AbortController in promptAborts alive during retries so
   * getStatus() continues to report BUSY.
   */
  private async executePromptWithRetry(
    ocClient: OpencodeClient,
    sessionId: string,
    parts: MessagePart[],
    modelParam: { providerID: string; modelID: string } | undefined,
    config: SessionConfig,
    promptAbort: AbortController
  ): Promise<void> {
    const maxRetries = OpencodeAdapter.PROMPT_MAX_RETRIES
    const baseDelay = OpencodeAdapter.PROMPT_RETRY_BASE_DELAY_MS

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (promptAbort.signal.aborted) return

      const promptStartTime = Date.now()
      if (attempt > 0) {
        console.log(`[OpencodeAdapter] Retry attempt ${attempt}/${maxRetries} for session ${sessionId}`)
      }

      try {
        const result: unknown = await ocClient.session.prompt({
          path: { id: sessionId },
          body: {
            parts: parts as unknown as Array<import('@opencode-ai/sdk').TextPartInput>,
            ...(modelParam && { model: modelParam }),
            ...(config.tools && { tools: config.tools })
          },
          ...(config.workspaceDir && { query: { directory: config.workspaceDir } }),
          signal: promptAbort.signal
        })

        const elapsed = Date.now() - promptStartTime
        console.log(`[OpencodeAdapter] Prompt completed for session ${sessionId} after ${elapsed}ms`)

        // Log tool call details from the response for debugging
        const res = result as { data?: { parts?: Array<Record<string, unknown>> } } | undefined
        if (res?.data?.parts) {
          const toolParts = res.data.parts.filter((p: Record<string, unknown>) => p.type === 'tool')
          if (toolParts.length > 0) {
            console.log(`[OpencodeAdapter] Response contains ${toolParts.length} tool part(s):`,
              toolParts.map((p: Record<string, unknown>) => ({
                tool: p.tool,
                status: (p.state as Record<string, unknown> | undefined)?.status
              }))
            )
          }
        }

        // Check for provider errors in the prompt response (e.g. quota exceeded,
        // payment required, rate limit).  OpenCode wraps these in result.data.info.error
        // but does NOT create a message with the error text, so pollMessages never
        // picks them up and the user sees "idle" with no response.
        const r = result as { data?: { info?: { error?: { name?: string; data?: { message?: string } } } } } | undefined
        const promptError = r?.data?.info?.error
        if (promptError) {
          const errorMsg = promptError.data?.message || promptError.name || 'Unknown provider error'

          // Retry transient errors (e.g. "Aborted" from config push tearing down the bus)
          if (this.isRetryablePromptError(errorMsg) && attempt < maxRetries) {
            const delay = baseDelay * Math.pow(2, attempt)
            console.warn(`[OpencodeAdapter] Retryable provider error "${errorMsg}" for ${sessionId}, retrying (${attempt + 1}/${maxRetries}) after ${delay}ms`)
            await new Promise(resolve => setTimeout(resolve, delay))
            continue
          }

          console.error(`[OpencodeAdapter] Provider error for ${sessionId}: ${errorMsg}`)
          this.promptErrors.set(sessionId, errorMsg)
          if (this.onDataAvailable) {
            this.onDataAvailable(sessionId)
          }
        }

        // Success or non-retryable error — stop retrying
        return
      } catch (err: unknown) {
        // User-initiated abort — exit silently
        if (err instanceof Error && err.name === 'AbortError') return

        const errorMsg = err instanceof Error ? err.message : String(err)

        // Retry transient HTTP-level errors
        if (this.isRetryablePromptError(errorMsg) && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt)
          console.warn(`[OpencodeAdapter] Retryable HTTP error "${errorMsg}" for ${sessionId}, retrying (${attempt + 1}/${maxRetries}) after ${delay}ms`)
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }

        console.error('[OpencodeAdapter] prompt error:', err)
        // Surface HTTP-level errors (network failures, 4xx/5xx, connection refused)
        // via promptErrors so getStatus() returns ERROR instead of silent IDLE.
        this.promptErrors.set(sessionId, errorMsg)
        if (this.onDataAvailable) {
          this.onDataAvailable(sessionId)
        }
        return
      }
    }
  }

  async getStatus(sessionId: string, config: SessionConfig): Promise<SessionStatus> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) {
      return { type: SessionStatusType.ERROR, message: 'Client not found' }
    }

    // Check for pending permissions BEFORE the promptAborts check.
    // Permissions block tool execution while the prompt HTTP call is still
    // in-flight.  If we don't surface them here, the session appears busy
    // forever because the prompt never completes.
    if (this.pendingPermissions.has(sessionId) && (this.pendingPermissions.get(sessionId)?.length ?? 0) > 0) {
      return { type: SessionStatusType.WAITING_APPROVAL }
    }

    // If the session.prompt() HTTP call is still in-flight, the agent is
    // definitely still working — regardless of what the status API reports.
    // This prevents premature IDLE detection when the status API briefly
    // returns idle between tool call rounds or when using models (like
    // featherless kimi k2.5) whose tool call format may not be fully
    // reflected in the status endpoint.
    if (this.promptAborts.has(sessionId)) {
      return { type: SessionStatusType.BUSY }
    }

    const statusResult = await ocClient.session.status({
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (!statusResult.data) {
      return this.resolveIdleOrPromptError(sessionId)
    }

    const ocStatus = statusResult.data[sessionId]
    if (!ocStatus) {
      return this.resolveIdleOrPromptError(sessionId)
    }

    const sdkType = (ocStatus.type || 'idle') as string
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

    // If the status API says idle, double-check the messages for tool parts
    // that are still pending/running. Some models (like featherless kimi k2.5)
    // may have tool calls in flight that the status API doesn't reflect.
    if (sdkType === 'idle') {
      try {
        const messagesResult = await ocClient.session.messages({
          path: { id: sessionId },
          ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
        })
        if (messagesResult.data && Array.isArray(messagesResult.data)) {
          // Check the last assistant message for pending tool parts
          for (let i = messagesResult.data.length - 1; i >= 0; i--) {
            const msg = messagesResult.data[i]
            if (!msg.info || msg.info.role === 'user') continue
            const parts = msg.parts || []
            for (const part of parts) {
              if (part.type === 'tool') {
                const state = (part as Record<string, unknown>).state as Record<string, unknown> | undefined
                const toolStatus = state?.status as string | undefined
                if (toolStatus === 'pending' || toolStatus === 'running') {
                  console.log(`[OpencodeAdapter] Status API says idle but tool part ${part.id} is ${toolStatus} — reporting BUSY`)
                  return { type: SessionStatusType.BUSY }
                }
              }
            }
            // Only check the last assistant message
            break
          }
        }
      } catch (err) {
        console.warn('[OpencodeAdapter] Failed to check messages for pending tools:', err)
      }
    }

    const statusType = sdkType.toUpperCase() as keyof typeof SessionStatusType
    const resolvedType = SessionStatusType[statusType] ?? SessionStatusType.IDLE

    if (resolvedType === SessionStatusType.IDLE) {
      return this.resolveIdleOrPromptError(sessionId)
    }

    return {
      type: resolvedType,
      message: 'message' in ocStatus ? (ocStatus as { message: string }).message : undefined
    }
  }

  /**
   * Returns ERROR with captured prompt error if one exists, otherwise IDLE.
   * Called from getStatus when the backend reports no active work.
   */
  private resolveIdleOrPromptError(sessionId: string): SessionStatus {
    const promptError = this.promptErrors.get(sessionId)
    if (promptError) {
      this.promptErrors.delete(sessionId)
      return { type: SessionStatusType.ERROR, message: promptError }
    }
    return { type: SessionStatusType.IDLE }
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
      for (const [partIndex, part] of parts.entries()) {
        const partId = this.getScopedPartId(String(msgId), part.id as string | undefined, partIndex)
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

    return newParts
  }

  async getRunningTools(sessionId: string, config: SessionConfig): Promise<Array<{
    partId: string
    toolName: string
    startTime?: number
    input?: Record<string, unknown>
  }>> {
    const ocClient = this.clients.get(sessionId)
    if (!ocClient) return []

    try {
      const messagesResult = await ocClient.session.messages({
        path: { id: sessionId },
        ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
      })

      if (!messagesResult.data || !Array.isArray(messagesResult.data)) return []

      const running: Array<{
        partId: string
        toolName: string
        startTime?: number
        input?: Record<string, unknown>
      }> = []

      for (const msg of messagesResult.data) {
        const parts = (msg as Record<string, unknown>).parts as Array<Record<string, unknown>> | undefined
        if (!parts || !Array.isArray(parts)) continue
        for (const part of parts) {
          if (part.type !== 'tool') continue
          const state = part.state as Record<string, unknown> | undefined
          if (!state || state.status !== 'running') continue
          const timeObj = state.time as Record<string, unknown> | undefined
          const input = state.input as Record<string, unknown> | undefined
          running.push({
            partId: part.id as string,
            toolName: (part.tool as string) || 'unknown',
            startTime: timeObj?.start as number | undefined,
            input: input || undefined
          })
        }
      }

      return running
    } catch (err) {
      console.warn(`[OpencodeAdapter] getRunningTools failed for ${sessionId}:`, err instanceof Error ? err.message : err)
      return []
    }
  }

  async abortPrompt(sessionId: string, _config: SessionConfig): Promise<void> {
    const abort = this.promptAborts.get(sessionId)
    if (abort) {
      abort.abort()
      this.promptAborts.delete(sessionId)
    }

    // Also abort the session on the server side to ensure the backend
    // stops processing. Without this, the backend continues running the
    // old prompt (model generating tokens, bash commands executing) and
    // rejects or queues new prompts — so the user can't recover by
    // sending a follow-up message.
    const ocClient = this.clients.get(sessionId)
    if (ocClient) {
      try {
        await ocClient.session.abort({
          path: { id: sessionId },
          ...(_config.workspaceDir && { query: { directory: _config.workspaceDir } }),
        })
        console.log(`[OpencodeAdapter] Server-side abort sent for session ${sessionId}`)
      } catch (err) {
        // Non-fatal: the local abort is sufficient for the HTTP request.
        // Server-side abort can fail if session is already idle or not found.
        console.warn(`[OpencodeAdapter] Server-side abort failed for ${sessionId}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  async destroySession(sessionId: string, _config: SessionConfig): Promise<void> {
    await this.abortPrompt(sessionId, _config)
    this.clients.delete(sessionId)
    this.promptClients.delete(sessionId)
    this.pendingPermissions.delete(sessionId)
    this.sessionPermissionModes.delete(sessionId)
    this.sessionWorkspaceDirs.delete(sessionId)
    this.sessionMcpConfigs.delete(sessionId)
    this.removeTillDoneSessionConfig(sessionId)

    if (this.clients.size > 0) {
      return
    }

    // Clean up generated runtime plugins and any support files they use.
    for (const filePath of [...this.pluginFilePaths, ...this.runtimeSupportFilePaths]) {
      if (filePath) {
        try {
          if (existsSync(filePath)) {
            rmSync(filePath)
            console.log(`[OpencodeAdapter] Removed runtime plugin file: ${filePath}`)
          }
        } catch (err) {
          console.warn(`[OpencodeAdapter] Failed to remove runtime plugin file: ${err}`)
        }
      }
    }
    this.pluginFilePaths = []
    this.runtimeSupportFilePaths = []
    this.tillDoneConfigPath = null
  }

  /**
   * Writes all generated runtime plugin files needed for this session.
   * MUST be called BEFORE ensureServerRunning() so plugins are discovered at startup.
   */
  private writeRuntimePluginFiles(config: SessionConfig): void {
    this.pluginFilePaths = []
    this.runtimeSupportFilePaths = []
    this.tillDoneConfigPath = null

    if (!config.workspaceDir) {
      return
    }

    const openCodeDir = join(config.workspaceDir, '.opencode')
    const pluginsDir = join(openCodeDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })

    this.writeTillDonePlugin(openCodeDir, pluginsDir, config.tillDone !== false)
    this.writeSecretPlugin(config, openCodeDir, pluginsDir)
  }

  private writeSecretPlugin(config: SessionConfig, openCodeDir: string, pluginsDir: string): void {
    const secretCount = config.secretEnvVars ? Object.keys(config.secretEnvVars).length : 0
    console.log(`[OpencodeAdapter] writeSecretFiles: workspaceDir=${config.workspaceDir}, secretCount=${secretCount}`)
    if (!config.secretEnvVars || secretCount === 0) {
      console.log(`[OpencodeAdapter] writeSecretFiles: skipping — no secrets or no workspaceDir`)
      return
    }

    // 1. Write pre-formatted export commands to a secrets file.
    //    The plugin reads this file on every bash invocation so updates take effect immediately.
    const exportLines = Object.entries(config.secretEnvVars)
      .map(([k, v]) => 'export ' + k + "='" + v.replace(/'/g, "'\\''" ) + "'")
      .join('\n')

    const secretsPath = join(openCodeDir, '.20x-secrets')
    writeFileSync(secretsPath, exportLines, 'utf-8')
    this.runtimeSupportFilePaths.push(secretsPath)

    // 2. Write the plugin JS that reads the secrets file and prepends exports to bash commands.
    //    Uses tool.execute.before hook (same pattern as Claude Code PreToolUse).
    const pluginPath = join(pluginsDir, '20x-secret-injector.js')
    const pluginCode = this.buildSecretInjectorPluginCode(secretsPath)

    writeFileSync(pluginPath, pluginCode, 'utf-8')
    this.pluginFilePaths.push(pluginPath)

    console.log(`[OpencodeAdapter] Wrote secret files: plugin=${pluginPath}, secrets=${secretsPath} (${Object.keys(config.secretEnvVars).length} secret(s))`)
  }

  private writeTillDonePlugin(openCodeDir: string, pluginsDir: string, enabled: boolean): void {
    const statePath = join(openCodeDir, '.20x-tilldone-state.json')
    if (!existsSync(statePath)) {
      writeFileSync(statePath, '{}\n', 'utf-8')
    }
    this.runtimeSupportFilePaths.push(statePath)

    const configPath = join(openCodeDir, '.20x-tilldone-config.json')
    const existingConfig = this.readTillDoneConfigFile(configPath)
    writeFileSync(configPath, JSON.stringify({ defaultEnabled: enabled, sessions: existingConfig.sessions }), 'utf-8')
    this.runtimeSupportFilePaths.push(configPath)
    this.tillDoneConfigPath = configPath

    const pluginPath = join(pluginsDir, '20x-tilldone.js')
    const pluginCode = this.buildTillDonePluginCode(statePath, configPath)
    writeFileSync(pluginPath, pluginCode, 'utf-8')
    this.pluginFilePaths.push(pluginPath)

    console.log(`[OpencodeAdapter] Wrote tilldone plugin: plugin=${pluginPath}, state=${statePath}, enabled=${enabled}`)
  }

  private readTillDoneConfig(): { defaultEnabled: boolean; sessions: Record<string, boolean> } {
    if (!this.tillDoneConfigPath) {
      return { defaultEnabled: true, sessions: {} }
    }

    return this.readTillDoneConfigFile(this.tillDoneConfigPath)
  }

  private readTillDoneConfigFile(configPath: string): { defaultEnabled: boolean; sessions: Record<string, boolean> } {
    if (!existsSync(configPath)) {
      return { defaultEnabled: true, sessions: {} }
    }

    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8') || '{}') as {
        defaultEnabled?: unknown
        enabled?: unknown
        sessions?: unknown
      }
      const sessions = parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
        ? Object.fromEntries(
          Object.entries(parsed.sessions as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'boolean')
        ) as Record<string, boolean>
        : {}

      return {
        defaultEnabled: parsed.defaultEnabled !== undefined
          ? parsed.defaultEnabled !== false
          : parsed.enabled !== false,
        sessions
      }
    } catch {
      return { defaultEnabled: true, sessions: {} }
    }
  }

  private writeTillDoneConfig(config: { defaultEnabled: boolean; sessions: Record<string, boolean> }): void {
    if (!this.tillDoneConfigPath) return
    writeFileSync(this.tillDoneConfigPath, JSON.stringify(config), 'utf-8')
  }

  private writeTillDoneSessionConfig(sessionId: string, enabled: boolean): void {
    const config = this.readTillDoneConfig()
    this.writeTillDoneConfig({
      ...config,
      sessions: {
        ...config.sessions,
        [sessionId]: enabled
      }
    })
  }

  private removeTillDoneSessionConfig(sessionId: string): void {
    if (!this.tillDoneConfigPath || !existsSync(this.tillDoneConfigPath)) return
    const config = this.readTillDoneConfig()
    if (!(sessionId in config.sessions)) return
    const sessions = { ...config.sessions }
    delete sessions[sessionId]
    this.writeTillDoneConfig({ ...config, sessions })
  }

  private buildSecretInjectorPluginCode(secretsPath: string): string {
    return [
      '// Auto-generated by 20x — do not edit. Removed on session destroy.',
      'import { readFileSync } from "fs";',
      '',
      'var SECRETS_PATH = ' + JSON.stringify(secretsPath) + ';',
      '',
      'export var SecretInjector = async function() {',
      '  return {',
      '    "tool.execute.before": async function(input, output) {',
      '      if (input.tool === "bash") {',
      '        try {',
      '          var exports = readFileSync(SECRETS_PATH, "utf-8").trim();',
      '          if (exports) output.args.command = exports + "\\n" + output.args.command;',
      '        } catch(e) {}',
      '      }',
      '    }',
      '  };',
      '};',
      ''
    ].join('\n')
  }

  private buildTillDonePluginCode(statePath: string, configPath: string): string {
    const initialTodoPrompt = 'TillDone: before using other tools, call the built-in todowrite tool to create a concise task list for this task. Keep the list current as you work.'

    return [
      '// Auto-generated by 20x — do not edit. Removed on session destroy.',
      'import { readFileSync, writeFileSync } from "fs";',
      '',
      'var STATE_PATH = ' + JSON.stringify(statePath) + ';',
      'var CONFIG_PATH = ' + JSON.stringify(configPath) + ';',
      'var INITIAL_TODO_PROMPT = ' + JSON.stringify(initialTodoPrompt) + ';',
      '',
      'function isTillDoneEnabled(sessionId) {',
      '  if (!sessionId) return false;',
      '  try {',
      '    var raw = readFileSync(CONFIG_PATH, "utf-8");',
      '    var parsed = JSON.parse(raw || "{}");',
      '    if (parsed?.sessions && typeof parsed.sessions === "object") {',
      '      if (Object.prototype.hasOwnProperty.call(parsed.sessions, sessionId)) {',
      '        return parsed.sessions[sessionId] !== false;',
      '      }',
      '      return false;',
      '    }',
      '    if (Object.prototype.hasOwnProperty.call(parsed || {}, "defaultEnabled")) {',
      '      return parsed.defaultEnabled !== false;',
      '    }',
      '    return parsed?.enabled !== false;',
      '  } catch (e) {',
      '    return false;',
      '  }',
      '}',
      '',
      'function readState() {',
      '  try {',
      '    var raw = readFileSync(STATE_PATH, "utf-8");',
      '    var parsed = JSON.parse(raw || "{}");',
      '    return parsed && typeof parsed === "object" ? parsed : {};',
      '  } catch (e) {',
      '    return {};',
      '  }',
      '}',
      '',
      'function writeState(state) {',
      '  try {',
      '    writeFileSync(STATE_PATH, JSON.stringify(state), "utf-8");',
      '  } catch (e) {}',
      '  return state;',
      '}',
      '',
      '// SDK types: tool.execute.before input has { tool, sessionID, callID }',
      '// SDK types: event hook input has { event: { type, properties: { sessionID, ... } } }',
      '',
      'function normalizeTodos(rawTodos) {',
      '  if (!Array.isArray(rawTodos)) return [];',
      '  return rawTodos.filter(Boolean).map(function(todo, index) {',
      '    return {',
      '      id: todo.id || String(index),',
      '      content: todo.content || todo.text || todo.title || "",',
      '      status: todo.status || "pending"',
      '    };',
      '  });',
      '}',
      '',
      'export var TillDone = async function({ client }) {',
      '  return {',
      '    "tool.execute.before": async function(input) {',
      '      if (input.tool === "todowrite") return;',
      '      var sessionId = input.sessionID;',
      '      if (!sessionId) return;',
      '      if (!isTillDoneEnabled(sessionId)) return;',
      '      var state = readState();',
      '      var todos = normalizeTodos((state[sessionId] || {}).todos);',
      '      if (todos.length === 0) {',
      '        throw new Error(INITIAL_TODO_PROMPT);',
      '      }',
      '    },',
      '    event: async function(input) {',
      '      var ev = input.event;',
      '      if (!ev) return;',
      '      var sessionId = ev.properties?.sessionID;',
      '      if (!sessionId) return;',
      '      if (!isTillDoneEnabled(sessionId)) return;',
      '      var state = readState();',
      '      var sessionState = state[sessionId] || { todos: [] };',
      '',
      '      if (ev.type === "todo.updated") {',
      '        sessionState.todos = normalizeTodos(ev.properties?.todos || []);',
      '        state[sessionId] = sessionState;',
      '        writeState(state);',
      '        return;',
      '      }',
      '',
      '      if (ev.type === "session.deleted") {',
      '        delete state[sessionId];',
      '        writeState(state);',
      '        return;',
      '      }',
      '    }',
      '  };',
      '};',
      ''
    ].join('\n')
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
    this.v2Client = OpenCodeV2Client.createOpencodeClient({ baseUrl })
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

  // ========================================================================
  // Permission handling — OpenCode file-permission prompts surfaced in 20x UI
  // ========================================================================

  /**
   * Returns the first pending permission for a session, formatted as an
   * approval request the agent-manager can render.  The agent-manager
   * duck-types for this method on any adapter during polling.
   */
  getPendingApproval(sessionId: string): {
    toolCallId: string
    question: string
    options: Array<{ optionId: string; name: string; kind: string }>
  } | null {
    const queue = this.pendingPermissions.get(sessionId)
    if (!queue || queue.length === 0) return null

    const pending = queue[0]
    const pathList = pending.patterns.length > 0
      ? pending.patterns.join(', ')
      : 'requested path'

    return {
      toolCallId: pending.permissionId,
      question: `Allow ${pending.permission} access to: ${pathList}`,
      options: [
        { optionId: 'allow', name: 'Yes', kind: 'option' },
        { optionId: 'allow-always', name: 'Always', kind: 'option' },
        { optionId: 'deny', name: 'No', kind: 'option' }
      ]
    }
  }

  /**
   * Responds to a pending permission via the OpenCode HTTP API.
   * Called by agent-manager when the user approves/denies in the UI.
   */
  async respondToApproval(
    sessionId: string,
    approved: boolean,
    optionId?: string
  ): Promise<boolean> {
    const queue = this.pendingPermissions.get(sessionId)
    if (!queue || queue.length === 0) {
      // Fallback: try the V2 API for pending permissions.
      // This handles the case where pendingPermissions was lost (e.g., app restart
      // or watchdog abort) but the permission is still pending in OpenCode.
      console.warn(`[OpencodeAdapter] No pending permission in memory for session ${sessionId}, trying V2 API fallback`)
      return await this.respondToPermissionViaV2(sessionId, approved, optionId)
    }

    const pending = queue.shift()!
    if (queue.length === 0) {
      this.pendingPermissions.delete(sessionId)
    }

    // OpenCode expects: "once" (allow this time), "always" (remember), or "reject" (deny)
    let response: string
    if (!approved) {
      response = 'reject'
    } else if (optionId === 'allow-always' || optionId === 'approved-for-session') {
      response = 'always'
    } else {
      response = 'once'
    }

    console.log(`[OpencodeAdapter] Responding to permission ${pending.permissionId}: ${response}`)

    try {
      const baseUrl = this.serverUrl || DEFAULT_SERVER_URL
      const url = `${baseUrl}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(pending.permissionId)}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response })
      })
      if (!res.ok) {
        console.warn(`[OpencodeAdapter] Permission response HTTP ${res.status}: ${await res.text().catch(() => '')}`)
      }
    } catch (err) {
      console.error(`[OpencodeAdapter] Failed to respond to permission ${pending.permissionId}:`, err)
    }

    // Trigger immediate poll so agent-manager sees next pending permission (if any)
    if (this.onDataAvailable) {
      this.onDataAvailable(sessionId)
    }
    return true
  }

  /**
   * Fallback: respond to a pending permission via the OpenCode V2 API.
   * Used when the in-memory pendingPermissions map is empty (e.g., after
   * app restart or watchdog abort) but the permission is still pending
   * in the OpenCode backend.
   *
   * Uses v2Client.permission.list() (top-level, lists all sessions) and
   * v2Client.permission.reply() to find and respond to the permission.
   */
  private async respondToPermissionViaV2(
    sessionId: string,
    approved: boolean,
    optionId?: string
  ): Promise<boolean> {
    try {
      if (!OpenCodeV2Client) {
        console.warn(`[OpencodeAdapter] Cannot fetch permissions — V2 SDK not loaded`)
        return false
      }
      const v2 = this.v2Client || OpenCodeV2Client.createOpencodeClient({
        baseUrl: this.serverUrl || DEFAULT_SERVER_URL
      })
      if (!this.v2Client) this.v2Client = v2

      // permission.list() returns ALL pending permissions across all sessions.
      // Filter to the target session.
      const listResult = await v2.permission.list({})
      if (listResult.error || !listResult.data) {
        console.warn(`[OpencodeAdapter] V2 permission.list() failed or returned no data for session ${sessionId}`)
        return false
      }

      const allPending = listResult.data as Array<{ id: string; sessionID: string; permission: string; patterns: string[] }>
      const sessionPending = allPending.filter(p => p.sessionID === sessionId)
      if (sessionPending.length === 0) {
        console.warn(`[OpencodeAdapter] No pending permissions found via V2 API for session ${sessionId}`)
        return false
      }

      const first = sessionPending[0]

      let reply: 'once' | 'always' | 'reject'
      if (!approved) {
        reply = 'reject'
      } else if (optionId === 'allow-always' || optionId === 'approved-for-session') {
        reply = 'always'
      } else {
        reply = 'once'
      }

      const directory = this.sessionWorkspaceDirs.get(sessionId)
      console.log(`[OpencodeAdapter] Responding to permission ${first.id} via V2 API: ${reply} (permission=${first.permission}, patterns=${first.patterns.join(', ')})`)
      await v2.permission.reply({
        requestID: first.id,
        reply,
        ...(directory && { directory })
      })

      // Trigger immediate poll so agent-manager sees the unblocked session
      if (this.onDataAvailable) {
        this.onDataAvailable(sessionId)
      }
      return true
    } catch (err) {
      console.error(`[OpencodeAdapter] V2 permission fallback failed for session ${sessionId}:`, err)
      return false
    }
  }

  /**
   * Subscribes to the OpenCode server's SSE event stream to capture
   * `permission.asked` events.  Must be called after the server is running.
   * Runs in the background; reconnects automatically on disconnect.
   */
  private startEventSubscription(): void {
    if (this.sseAbort || !this.serverUrl) return
    this.sseAbort = new AbortController()

    // Fire-and-forget — reconnection loop runs in the background
    this.processEventStream(this.sseAbort.signal).catch(() => {})
  }

  private async processEventStream(signal: AbortSignal): Promise<void> {
    const baseUrl = this.serverUrl || DEFAULT_SERVER_URL
    const url = `${baseUrl}/global/event`

    while (!signal.aborted) {
      try {
        const response = await (globalThis as unknown as { fetch: typeof fetch }).fetch(url, {
          signal,
          headers: { 'Accept': 'text/event-stream' }
        })

        const reader = response.body?.getReader()
        if (!reader) return

        const decoder = new TextDecoder()
        let buffer = ''

        while (!signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // Parse newline-delimited SSE data lines
          let nlIdx: number
          while ((nlIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nlIdx).trim()
            buffer = buffer.slice(nlIdx + 1)

            if (line.startsWith('data: ') || line.startsWith('data:')) {
              const json = line.startsWith('data: ') ? line.slice(6) : line.slice(5)
              if (!json) continue
              try {
                const event = JSON.parse(json) as Record<string, unknown>
                this.handleServerEvent(event)
              } catch {
                // Not valid JSON — skip
              }
            }
          }
        }
      } catch (err: unknown) {
        if (signal.aborted) return
        if (err instanceof Error && err.name === 'AbortError') return
        console.warn('[OpencodeAdapter] SSE connection error, reconnecting in 3s:', err instanceof Error ? err.message : err)
        await new Promise(resolve => setTimeout(resolve, 3_000))
      }
    }
  }

  /**
   * Handle a single SSE event from the OpenCode server.
   * We only care about `permission.asked` events.
   *
   * The /global/event endpoint wraps events in a `payload` envelope:
   *   { payload: { id, type, properties } }
   * The /event endpoint returns events directly:
   *   { id, type, properties }
   * We handle both formats.
   */
  private handleServerEvent(event: Record<string, unknown>): void {
    // Unwrap /global/event payload envelope if present
    const inner = (event.payload || event) as Record<string, unknown>
    const type = inner.type as string | undefined
    if (type !== 'permission.asked') return

    const props = (inner.properties || inner) as Record<string, unknown>
    const permissionId = (props.id || props.permissionID) as string | undefined
    const sessionID = (props.sessionID || props.sessionId) as string | undefined
    const permission = (props.permission || props.name || 'unknown') as string
    const patterns = (props.patterns || []) as string[]

    if (!permissionId || !sessionID) {
      console.warn('[OpencodeAdapter] permission.asked event missing id or sessionID:', JSON.stringify(event).slice(0, 300))
      return
    }

    console.log(`[OpencodeAdapter] Permission requested: ${permission} for session ${sessionID} (${permissionId}) patterns=${patterns.join(', ')}`)

    // Auto-approve if the agent's permission mode is 'allow'
    const mode = this.sessionPermissionModes.get(sessionID) || 'ask'
    if (mode === 'allow') {
      console.log(`[OpencodeAdapter] Auto-approving permission ${permissionId} (permissionMode=allow)`)
      this.autoApprovePermission(sessionID, permissionId).catch(err => {
        console.error(`[OpencodeAdapter] Auto-approve failed for ${permissionId}:`, err)
      })
      return
    }

    // Append to the session's permission queue for UI handling
    let queue = this.pendingPermissions.get(sessionID)
    if (!queue) {
      queue = []
      this.pendingPermissions.set(sessionID, queue)
    }
    // Deduplicate by permissionId
    if (!queue.some(p => p.permissionId === permissionId)) {
      queue.push({ permissionId, permission, patterns })
    }

    // Trigger immediate poll so agent-manager renders the approval prompt
    if (this.onDataAvailable) {
      this.onDataAvailable(sessionID)
    }
  }

  /**
   * Silently approve a permission request (used when permissionMode is 'allow').
   * Uses the V2 SDK permission.reply() which hits the correct endpoint
   * (POST /permission/{requestID}/reply). The V1 endpoint
   * (POST /session/{id}/permissions/{permissionID}) returns 404 for
   * permissions created by the V2 system.
   */
  private async autoApprovePermission(sessionId: string, permissionId: string): Promise<void> {
    // Resolve the workspace directory for this session — the OpenCode server
    // may need it to properly scope the permission reply.
    const directory = this.sessionWorkspaceDirs.get(sessionId)

    try {
      // Try V2 SDK first — this is the correct endpoint for V2 permissions
      if (OpenCodeV2Client) {
        const v2 = this.v2Client || OpenCodeV2Client.createOpencodeClient({
          baseUrl: this.serverUrl || DEFAULT_SERVER_URL
        })
        if (!this.v2Client) this.v2Client = v2

        await v2.permission.reply({
          requestID: permissionId,
          reply: 'always',
          ...(directory && { directory })
        })
        console.log(`[OpencodeAdapter] Auto-approved permission ${permissionId} via V2 API${directory ? ` (dir=${directory})` : ''}`)
        return
      }

      // Fallback to raw fetch if V2 SDK is not available
      const baseUrl = this.serverUrl || DEFAULT_SERVER_URL
      const dirQuery = directory ? `?directory=${encodeURIComponent(directory)}` : ''
      const url = `${baseUrl}/permission/${encodeURIComponent(permissionId)}/reply${dirQuery}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply: 'always' })
      })
      if (!res.ok) {
        console.warn(`[OpencodeAdapter] Auto-approve HTTP ${res.status}: ${await res.text().catch(() => '')}`)
      }
    } catch (err) {
      console.error(`[OpencodeAdapter] Auto-approve failed for ${permissionId}:`, err)
    }
  }

  private stopEventSubscription(): void {
    if (this.sseAbort) {
      this.sseAbort.abort()
      this.sseAbort = null
    }
  }

  async stopServer(): Promise<void> {
    this.stopEventSubscription()
    this.pendingPermissions.clear()
    if (this.serverInstance) {
      try {
        await (this.serverInstance as { close: () => Promise<void> }).close()
      } catch (error) {
        console.error('[OpencodeAdapter] Error stopping server:', error)
      }
      this.serverInstance = null
      this.serverUrl = null
      this.sharedClient = null
      this.quickClient = null
      this.v2Client = null
      this.configPushed = false
    }
  }
}
