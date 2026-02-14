import { Agent as UndiciAgent } from 'undici'
import type {
  CodingAgentAdapter,
  SessionConfig,
  SessionStatus,
  SessionMessage,
  MessagePart
} from './coding-agent-adapter'
import { SessionStatusType } from './coding-agent-adapter'

let OpenCodeSDK: typeof import('@opencode-ai/sdk') | null = null

// Custom fetch with no timeout — agent prompts can run indefinitely
const noTimeoutAgent = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 })
const noTimeoutFetch = (req: any) => (globalThis as any).fetch(req, { dispatcher: noTimeoutAgent })

const DEFAULT_SERVER_URL = 'http://localhost:4096'

/**
 * Adapter for OpenCode backend
 */
export class OpencodeAdapter implements CodingAgentAdapter {
  private sdkLoading: Promise<void> | null = null
  private serverInstance: any = null
  private serverUrl: string | null = null
  private serverStarting: Promise<void> | null = null
  private clients: Map<string, any> = new Map() // sessionId -> ocClient
  private promptAborts: Map<string, AbortController> = new Map()

  constructor() {
    this.sdkLoading = this.loadSDK()
  }

  private async loadSDK(): Promise<void> {
    try {
      OpenCodeSDK = await import('@opencode-ai/sdk')
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
    } catch (error) {
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

        const result = await OpenCodeSDK!.createOpencode({ hostname, port })
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
    await this.ensureServerRunning(config.serverUrl || DEFAULT_SERVER_URL)

    const baseUrl = this.serverUrl || config.serverUrl || DEFAULT_SERVER_URL
    const ocClient = OpenCodeSDK!.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch as any })

    // Create OpenCode session
    const result: any = await ocClient.session.create({
      body: { title: `Task ${config.taskId}` },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (result.error) {
      throw new Error(result.error.data?.message || result.error.name || 'Failed to create session')
    }
    if (!result.data?.id) {
      throw new Error('No session ID returned from OpenCode')
    }

    const ocSessionId = result.data.id
    this.clients.set(ocSessionId, ocClient)

    return ocSessionId
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    await this.ensureServerRunning(config.serverUrl || DEFAULT_SERVER_URL)

    const baseUrl = this.serverUrl || config.serverUrl || DEFAULT_SERVER_URL
    const ocClient = OpenCodeSDK!.createOpencodeClient({ baseUrl, fetch: noTimeoutFetch as any })

    // Validate session exists
    const getResult: any = await ocClient.session.get({
      path: { id: sessionId },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (getResult.error || !getResult.data) {
      throw new Error('Session no longer exists on server')
    }

    this.clients.set(sessionId, ocClient)

    // Fetch existing messages
    const messagesResult: any = await ocClient.session.messages({
      path: { id: sessionId },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    const messages: SessionMessage[] = []
    if (messagesResult.data && Array.isArray(messagesResult.data)) {
      for (const msg of messagesResult.data) {
        if (!msg.info) continue
        messages.push({
          id: msg.info.id,
          role: msg.info.role || 'assistant',
          parts: msg.parts || []
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
        parts,
        ...(modelParam && { model: modelParam }),
        ...(config.tools && { tools: config.tools })
      },
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } }),
      signal: promptAbort.signal
    }).catch((err: any) => {
      if (err.name !== 'AbortError') {
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

    const statusResult: any = await ocClient.session.status({
      ...(config.workspaceDir && { query: { directory: config.workspaceDir } })
    })

    if (!statusResult.data) {
      return { type: SessionStatusType.IDLE }
    }

    const ocStatus = statusResult.data[sessionId]
    if (!ocStatus) {
      return { type: SessionStatusType.IDLE }
    }

    return {
      type: ocStatus.type || SessionStatusType.IDLE,
      message: ocStatus.message
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

    const messagesResult: any = await ocClient.session.messages({
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

      // Skip if already seen and no parts have changed
      const isNewMessage = !seenMessageIds.has(msgId)
      if (isNewMessage) {
        seenMessageIds.add(msgId)
      }

      const parts = msg.parts && Array.isArray(msg.parts) ? msg.parts : []
      for (const part of parts) {
        const partId = part.id
        if (!partId) continue

        const isNewPart = !seenPartIds.has(partId)
        const isUpdatable = part.type === 'text' || part.type === 'reasoning' || part.type === 'tool'

        if (isUpdatable) {
          const fingerprint = part.type === 'tool'
            ? `${part.state?.status}:${part.type}:${part.text?.length ?? 0}:${part.tool?.output?.length ?? 0}`
            : String(part.text?.length ?? 0)

          const oldFingerprint = partContentLengths.get(partId)
          const hasChanged = oldFingerprint !== fingerprint

          if (isNewPart || hasChanged) {
            seenPartIds.add(partId)
            partContentLengths.set(partId, fingerprint)
            newParts.push({
              id: partId,
              type: part.type,
              text: part.text,
              content: part.text,
              tool: part.tool,
              state: part.state
            })
          }
        } else if (isNewPart) {
          seenPartIds.add(partId)
          newParts.push({
            id: partId,
            type: part.type,
            text: part.text,
            content: part.text
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

  async stopServer(): Promise<void> {
    if (this.serverInstance) {
      try {
        await this.serverInstance.close()
      } catch (error) {
        console.error('[OpencodeAdapter] Error stopping server:', error)
      }
      this.serverInstance = null
      this.serverUrl = null
    }
  }
}
