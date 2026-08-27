/**
 * Pi coding-agent adapter.
 *
 * Pi exposes a JSONL RPC protocol over stdin/stdout. 20x keeps one Pi process
 * per live session and converts Pi events to the shared adapter message shape.
 */

import { spawn, execFile } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { promisify } from 'util'
import type { DatabaseManager } from '../database'
import {
  ENTERPRISE_AI_GATEWAY_PROVIDER_ID,
  ENTERPRISE_AI_GATEWAY_PROVIDER_NAME,
  buildPiAiGatewayProviderConfig,
  readEnterpriseAiGatewayConfig,
} from '../enterprise-ai-gateway'
import type {
  CodingAgentAdapter,
  MessagePart,
  SessionConfig,
  SessionMessage,
  SessionStatus,
} from './coding-agent-adapter'
import { MessagePartType, MessageRole, SessionStatusType } from './coding-agent-adapter'

const execFileAsync = promisify(execFile)
const RPC_TIMEOUT_MS = 15_000
const MAX_BUFFERED_PARTS = 1_000

interface PiRpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: Record<string, unknown>
  error?: string
}

interface PendingRequest {
  resolve: (response: PiRpcResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface PiSession {
  id: string
  process: ChildProcessWithoutNullStreams
  config: SessionConfig
  status: 'idle' | 'busy' | 'error'
  lastError: string | null
  pending: Map<string, PendingRequest>
  parts: MessagePart[]
  allMessages: SessionMessage[]
  stdoutBuffer: string
  textByBlock: Map<string, string>
  reasoningByBlock: Map<string, string>
  toolParts: Map<string, MessagePart>
  turn: number
  mcpConfigPath?: string
}

type PiMessage = {
  role?: string
  content?: string | Array<Record<string, unknown>>
  timestamp?: number
  stopReason?: string
  errorMessage?: string
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
    .filter((block) => block.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('')
}

function resultText(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
    .map((block) => block.type === 'text' ? String(block.text ?? '') : JSON.stringify(block))
    .join('\n')
}

export class PiAdapter implements CodingAgentAdapter {
  private sessions = new Map<string, PiSession>()
  private piExecutablePath: string | null = null
  onDataAvailable?: (sessionId: string) => void

  constructor(private db: Pick<DatabaseManager, 'getSetting'>) {}

  async initialize(): Promise<void> {
    await this.findPiExecutable()
  }

  private async findPiExecutable(): Promise<string> {
    if (this.piExecutablePath) return this.piExecutablePath
    const isWin = process.platform === 'win32'
    try {
      const { stdout } = await execFileAsync(isWin ? 'where' : 'which', ['pi'], {
        timeout: 10_000,
        windowsHide: true,
      })
      this.piExecutablePath = stdout.trim().split(/\r?\n/)[0]
      return this.piExecutablePath
    } catch {
      const home = homedir()
      const candidates = isWin
        ? [
            join(home, 'AppData', 'Roaming', 'npm', 'pi.cmd'),
            join(home, 'AppData', 'Roaming', 'npm', 'pi.exe'),
          ]
        : [
            '/opt/homebrew/bin/pi',
            '/usr/local/bin/pi',
            join(home, '.local', 'bin', 'pi'),
            join(home, '.npm-global', 'bin', 'pi'),
            join(home, '.volta', 'bin', 'pi'),
          ]
      const found = candidates.find(existsSync)
      if (!found) {
        throw new Error('Pi CLI not found. Install it with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent')
      }
      this.piExecutablePath = found
      return found
    }
  }

  /**
   * Install or update the Peakflo provider in Pi's normal models file. The key
   * remains an environment reference; 20x supplies the decrypted value only to
   * the child process.
   */
  private installPeakfloGateway(): { apiKey: string; providerModels: Array<{ id: string; name: string }> } | null {
    const gateway = readEnterpriseAiGatewayConfig(this.db)
    if (!gateway) return null

    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
    const modelsPath = join(agentDir, 'models.json')
    mkdirSync(dirname(modelsPath), { recursive: true })

    let root: { providers?: Record<string, unknown> } = {}
    if (existsSync(modelsPath)) {
      try {
        root = JSON.parse(readFileSync(modelsPath, 'utf8')) as { providers?: Record<string, unknown> }
      } catch (error) {
        throw new Error(`Pi models file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const providers = { ...(root.providers ?? {}) }
    providers[ENTERPRISE_AI_GATEWAY_PROVIDER_ID] = buildPiAiGatewayProviderConfig(gateway)

    const temporaryPath = `${modelsPath}.20x-${process.pid}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify({ ...root, providers }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, modelsPath)
    chmodSync(modelsPath, 0o600)

    return { apiKey: gateway.apiKey, providerModels: gateway.models ?? [] }
  }

  private buildMcpConfig(config: SessionConfig): string | undefined {
    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) return undefined
    const dir = join(homedir(), '.20x', 'pi-mcp')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${config.taskId}-${randomUUID()}.json`)
    const mcpServers = Object.fromEntries(Object.entries(config.mcpServers).map(([name, server]) => {
      if (server.type === 'stdio') {
        return [name, {
          command: server.command,
          args: server.args ?? [],
          env: server.env ?? {},
        }]
      }
      return [name, {
        url: server.url,
        headers: server.headers ?? {},
      }]
    }))
    writeFileSync(path, `${JSON.stringify({ mcpServers }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    return path
  }

  private splitModel(model?: string): { provider?: string; modelId?: string } {
    if (!model) return {}
    const separator = model.indexOf('/')
    if (separator < 0) return { modelId: model }
    return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) }
  }

  private async spawnSession(config: SessionConfig, resumeId?: string): Promise<PiSession> {
    const executable = await this.findPiExecutable()
    const gateway = this.installPeakfloGateway()
    const mcpConfigPath = this.buildMcpConfig(config)
    const sessionDir = join(homedir(), '.20x', 'pi-sessions')
    mkdirSync(sessionDir, { recursive: true })

    const args = ['--mode', 'rpc', '--approve', '--session-dir', sessionDir, '--name', config.taskId]
    if (config.systemPrompt?.trim()) {
      args.push('--append-system-prompt', config.systemPrompt.trim())
    }
    if (resumeId) args.push('--session', resumeId)
    const { provider, modelId } = this.splitModel(config.model)
    if (provider) args.push('--provider', provider)
    if (modelId) args.push('--model', modelId)
    if (config.reasoningEffort) args.push('--thinking', config.reasoningEffort)
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath)

    const env = {
      ...process.env,
      ...(config.secretEnvVars ?? {}),
      ...(gateway ? { PEAKFLO_AI_GATEWAY_API_KEY: gateway.apiKey } : {}),
    } as NodeJS.ProcessEnv
    delete env.AI_AGENT
    delete env.PI_CODING_AGENT

    const child = spawn(executable, args, {
      cwd: config.workspaceDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    })

    const tempId = resumeId || randomUUID()
    const session: PiSession = {
      id: tempId,
      process: child,
      config,
      status: 'idle',
      lastError: null,
      pending: new Map(),
      parts: [],
      allMessages: [],
      stdoutBuffer: '',
      textByBlock: new Map(),
      reasoningByBlock: new Map(),
      toolParts: new Map(),
      turn: 0,
      mcpConfigPath,
    }
    this.sessions.set(tempId, session)
    this.attachProcess(session)

    const state = await this.command(session, { type: 'get_state' })
    const realId = typeof state.data?.sessionId === 'string' ? state.data.sessionId : tempId
    session.id = realId
    if (realId !== tempId) {
      this.sessions.delete(tempId)
      this.sessions.set(realId, session)
    }
    return session
  }

  async createSession(config: SessionConfig): Promise<string> {
    const session = await this.spawnSession(config)
    return session.id
  }

  async resumeSession(sessionId: string, config: SessionConfig): Promise<SessionMessage[]> {
    const session = await this.spawnSession(config, sessionId)
    const response = await this.command(session, { type: 'get_messages' })
    const messages = Array.isArray(response.data?.messages) ? response.data.messages as PiMessage[] : []
    session.allMessages = this.convertMessages(messages)
    return session.allMessages
  }

  private attachProcess(session: PiSession): void {
    session.process.stdout.on('data', (chunk: Buffer | string) => {
      session.stdoutBuffer += chunk.toString()
      while (true) {
        const newline = session.stdoutBuffer.indexOf('\n')
        if (newline < 0) break
        let line = session.stdoutBuffer.slice(0, newline)
        session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line.trim()) continue
        try {
          this.handleEvent(session, JSON.parse(line) as Record<string, unknown>)
        } catch (error) {
          console.warn('[PiAdapter] Invalid RPC output:', error)
        }
      }
    })
    session.process.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim()
      if (text) console.warn(`[PiAdapter/${session.id}] ${text.slice(0, 2_000)}`)
    })
    session.process.on('error', (error) => {
      session.status = 'error'
      session.lastError = error.message
      this.rejectPending(session, error)
      this.onDataAvailable?.(session.id)
    })
    session.process.on('exit', (code, signal) => {
      if (session.status === 'busy') {
        session.status = 'error'
        session.lastError = `Pi exited before the turn completed (${signal || `code ${code}`})`
      }
      this.rejectPending(session, new Error(session.lastError || 'Pi process exited'))
      this.onDataAvailable?.(session.id)
    })
  }

  private rejectPending(session: PiSession, error: Error): void {
    for (const request of session.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    session.pending.clear()
  }

  private handleEvent(session: PiSession, event: Record<string, unknown>): void {
    if (event.type === 'response') {
      const response = event as unknown as PiRpcResponse
      if (response.id) {
        const pending = session.pending.get(response.id)
        if (pending) {
          clearTimeout(pending.timer)
          session.pending.delete(response.id)
          if (response.success) pending.resolve(response)
          else pending.reject(new Error(response.error || `Pi ${response.command} failed`))
        }
      }
      return
    }

    switch (event.type) {
      case 'agent_start':
        session.status = 'busy'
        session.lastError = null
        session.turn++
        break
      case 'agent_settled':
        session.status = 'idle'
        break
      case 'message_update':
        this.handleMessageUpdate(session, event.assistantMessageEvent as Record<string, unknown> | undefined)
        break
      case 'message_end': {
        const message = event.message as PiMessage | undefined
        if (message?.role === 'assistant' && message.stopReason === 'error') {
          const text = message.errorMessage || 'Pi model request failed'
          session.parts.push({ id: `pi-error-${session.turn}`, type: MessagePartType.ERROR, text })
          session.lastError = text
        }
        break
      }
      case 'tool_execution_start':
        this.handleToolEvent(session, event, 'running')
        break
      case 'tool_execution_update':
        this.handleToolEvent(session, event, 'running')
        break
      case 'tool_execution_end':
        this.handleToolEvent(session, event, event.isError ? 'error' : 'completed')
        break
      case 'auto_retry_start':
        session.status = 'busy'
        break
      case 'auto_retry_end':
        if (event.success === false) {
          session.lastError = String(event.finalError || 'Pi retry failed')
        }
        break
      case 'extension_error':
        session.parts.push({
          id: `pi-extension-error-${randomUUID()}`,
          type: MessagePartType.ERROR,
          text: String(event.error || 'Pi extension failed'),
        })
        break
    }

    if (session.parts.length > MAX_BUFFERED_PARTS) {
      session.parts.splice(0, session.parts.length - MAX_BUFFERED_PARTS)
    }
    this.onDataAvailable?.(session.id)
  }

  private handleMessageUpdate(session: PiSession, update?: Record<string, unknown>): void {
    if (!update) return
    const index = String(update.contentIndex ?? 0)
    if (update.type === 'text_delta') {
      const key = `${session.turn}:${index}`
      const text = (session.textByBlock.get(key) || '') + String(update.delta || '')
      session.textByBlock.set(key, text)
      session.parts.push({ id: `pi-text-${key}`, type: MessagePartType.TEXT, text, update: true })
    } else if (update.type === 'thinking_delta') {
      const key = `${session.turn}:${index}`
      const text = (session.reasoningByBlock.get(key) || '') + String(update.delta || '')
      session.reasoningByBlock.set(key, text)
      session.parts.push({ id: `pi-reasoning-${key}`, type: MessagePartType.REASONING, text, update: true })
    }
  }

  private handleToolEvent(session: PiSession, event: Record<string, unknown>, status: string): void {
    const id = String(event.toolCallId || randomUUID())
    const existing = session.toolParts.get(id)
    const output = resultText(event.result ?? event.partialResult)
    const tool: NonNullable<MessagePart['tool']> = {
      name: String(event.toolName || existing?.tool?.name || 'tool'),
      status,
      input: event.args ?? existing?.tool?.input,
      output: output || existing?.tool?.output,
      error: status === 'error' ? output || 'Tool failed' : undefined,
    }
    const part: MessagePart = { id: `pi-tool-${id}`, type: MessagePartType.TOOL, tool, update: !!existing }
    session.toolParts.set(id, part)
    session.parts.push(part)
  }

  private command(session: PiSession, command: Record<string, unknown>): Promise<PiRpcResponse> {
    if (session.process.exitCode !== null || !session.process.stdin.writable) {
      return Promise.reject(new Error('Pi process is not running'))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id)
        reject(new Error(`Pi RPC command timed out: ${String(command.type)}`))
      }, RPC_TIMEOUT_MS)
      session.pending.set(id, { resolve, reject, timer })
      session.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        session.pending.delete(id)
        reject(error)
      })
    })
  }

  async sendPrompt(sessionId: string, parts: MessagePart[], _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const message = parts.filter((part) => part.type === MessagePartType.TEXT && part.text).map((part) => part.text).join('\n')
    if (!message) throw new Error('No text content in prompt parts')
    const wasBusy = session.status === 'busy'
    session.status = 'busy'
    await this.command(session, {
      type: 'prompt',
      message,
      ...(wasBusy ? { streamingBehavior: 'followUp' } : {}),
    })
  }

  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId)
    if (!session) return { type: SessionStatusType.ERROR, message: 'Session not found' }
    if (session.lastError) return { type: SessionStatusType.ERROR, message: session.lastError }
    return { type: session.status === 'busy' ? SessionStatusType.BUSY : SessionStatusType.IDLE }
  }

  async pollMessages(sessionId: string): Promise<MessagePart[]> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    return session.parts.splice(0)
  }

  private convertMessages(messages: PiMessage[]): SessionMessage[] {
    return messages.flatMap((message, index) => {
      if (message.role !== 'user' && message.role !== 'assistant') return []
      const text = textFromContent(message.content)
      if (!text) return []
      return [{
        id: `pi-history-${message.timestamp ?? index}`,
        role: message.role === 'user' ? MessageRole.USER : MessageRole.ASSISTANT,
        parts: [{ id: `pi-history-part-${message.timestamp ?? index}`, type: MessagePartType.TEXT, text }],
      }]
    })
  }

  async getAllMessages(sessionId: string): Promise<SessionMessage[]> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    try {
      const response = await this.command(session, { type: 'get_messages' })
      const messages = Array.isArray(response.data?.messages) ? response.data.messages as PiMessage[] : []
      session.allMessages = this.convertMessages(messages)
    } catch {
      // Use the last successful snapshot when the process has already ended.
    }
    return session.allMessages
  }

  async abortPrompt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    await this.command(session, { type: 'abort' })
    session.status = 'idle'
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.process.kill()
    this.sessions.delete(sessionId)
    if (session.mcpConfigPath && existsSync(session.mcpConfigPath)) {
      unlinkSync(session.mcpConfigPath)
    }
  }

  async registerMcpServer(
    _serverName: string,
    _mcpConfig: { type: 'local' | 'remote'; command?: string[]; args?: string[]; url?: string; headers?: Record<string, string>; environment?: Record<string, string> },
    _workspaceDir?: string,
  ): Promise<void> {
    // MCP servers are supplied per process through pi-mcp-adapter.
  }

  async checkHealth(): Promise<{ available: boolean; reason?: string }> {
    try {
      const executable = await this.findPiExecutable()
      await execFileAsync(executable, ['--version'], { timeout: 10_000, windowsHide: true })
      return { available: true }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async getProviders(): Promise<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>; default: Record<string, string> }> {
    const gateway = readEnterpriseAiGatewayConfig(this.db)
    if (!gateway) return { providers: [], default: {} }
    return {
      providers: [{
        id: ENTERPRISE_AI_GATEWAY_PROVIDER_ID,
        name: ENTERPRISE_AI_GATEWAY_PROVIDER_NAME,
        models: gateway.models ?? [],
      }],
      default: {},
    }
  }
}
