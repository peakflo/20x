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
import { StringDecoder } from 'string_decoder'
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
const MINIMUM_PI_VERSION = [0, 80, 5] as const
const PI_PERMISSION_MODE_ENV = 'TWENTYX_PI_PERMISSION_MODE'
const TERMINAL_ERROR_SETTLE_GRACE_MS = 1_000

const PI_PERMISSION_EXTENSION_SOURCE = `\
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

function inputSummary(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2).slice(0, 4000);
  } catch {
    return String(input).slice(0, 4000);
  }
}

export default function permissions(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (process.env.${PI_PERMISSION_MODE_ENV} === "allow" || READ_ONLY_TOOLS.has(event.toolName)) return;
    const approved = await ctx.ui.confirm(
      \`Allow \${event.toolName}?\`,
      inputSummary(event.input),
    );
    if (!approved) return { block: true, reason: \`\${event.toolName} was declined in 20x.\` };
  });
}
`

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
  stdoutDecoder: StringDecoder
  textByBlock: Map<string, string>
  reasoningByBlock: Map<string, string>
  toolParts: Map<string, MessagePart>
  pendingUiRequests: Map<string, PiUiRequest>
  turn: number
  assistantMessageOrdinal: number
  pendingTurnError: string | null
  pendingTurnErrorMonotonicTime: number | null
  sawAgentActivity: boolean
  promptMayBeCommandOnly: boolean
  closing: boolean
  mcpConfigPath?: string
}

interface PiUiRequest {
  id: string
  method: 'confirm' | 'select' | 'input' | 'editor'
  title: string
  message: string
  options: string[]
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

  private installPermissionExtension(): string {
    const dir = join(homedir(), '.20x', 'pi')
    const path = join(dir, 'permissions.ts')
    mkdirSync(dir, { recursive: true })
    const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (current !== PI_PERMISSION_EXTENSION_SOURCE) {
      const temporaryPath = `${path}.${process.pid}.tmp`
      writeFileSync(temporaryPath, PI_PERMISSION_EXTENSION_SOURCE, { mode: 0o600 })
      chmodSync(temporaryPath, 0o600)
      renameSync(temporaryPath, path)
    }
    chmodSync(path, 0o600)
    return path
  }

  private processEnv(
    config: SessionConfig,
    gateway: { apiKey: string } | null,
  ): NodeJS.ProcessEnv {
    const env = {
      ...process.env,
      ...(config.secretEnvVars ?? {}),
      ...(gateway ? { PEAKFLO_AI_GATEWAY_API_KEY: gateway.apiKey } : {}),
      [PI_PERMISSION_MODE_ENV]: config.permissionMode ?? 'ask',
    } as NodeJS.ProcessEnv
    delete env.AI_AGENT
    delete env.PI_CODING_AGENT
    return env
  }

  private createSessionState(
    id: string,
    child: ChildProcessWithoutNullStreams,
    config: SessionConfig,
    mcpConfigPath?: string,
  ): PiSession {
    return {
      id,
      process: child,
      config,
      status: 'idle',
      lastError: null,
      pending: new Map(),
      parts: [],
      allMessages: [],
      stdoutBuffer: '',
      stdoutDecoder: new StringDecoder('utf8'),
      textByBlock: new Map(),
      reasoningByBlock: new Map(),
      toolParts: new Map(),
      pendingUiRequests: new Map(),
      turn: 0,
      assistantMessageOrdinal: 0,
      pendingTurnError: null,
      pendingTurnErrorMonotonicTime: null,
      sawAgentActivity: false,
      promptMayBeCommandOnly: false,
      closing: false,
      mcpConfigPath,
    }
  }

  private splitModel(model?: string): { provider?: string; modelId?: string } {
    if (!model) return {}
    const separator = model.indexOf('/')
    if (separator < 0) return { modelId: model }
    return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) }
  }

  private async applySelection(session: PiSession, config: SessionConfig): Promise<void> {
    if (config.model && config.model !== 'default') {
      const { provider, modelId } = this.splitModel(config.model)
      if (!provider || !modelId) {
        throw new Error(`Pi model must use provider/model format: ${config.model}`)
      }
      await this.command(session, { type: 'set_model', provider, modelId })
    }
    if (config.reasoningEffort) {
      await this.command(session, { type: 'set_thinking_level', level: config.reasoningEffort })
    }
  }

  private async spawnSession(config: SessionConfig, resumeId?: string): Promise<PiSession> {
    const executable = await this.findPiExecutable()
    const gateway = this.installPeakfloGateway()
    const mcpConfigPath = this.buildMcpConfig(config)
    const permissionExtension = this.installPermissionExtension()

    const args = ['--mode', 'rpc', '--approve', '--name', config.taskId, '--extension', permissionExtension]
    if (config.systemPrompt?.trim()) {
      args.push('--append-system-prompt', config.systemPrompt.trim())
    }
    if (resumeId) args.push('--session', resumeId)
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath)

    const child = spawn(executable, args, {
      cwd: config.workspaceDir,
      env: this.processEnv(config, gateway),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
    })

    const tempId = resumeId || randomUUID()
    const session = this.createSessionState(tempId, child, config, mcpConfigPath)
    this.sessions.set(tempId, session)
    this.attachProcess(session)

    try {
      const state = await this.command(session, { type: 'get_state' })
      const realId = typeof state.data?.sessionFile === 'string'
        ? state.data.sessionFile
        : typeof state.data?.sessionId === 'string' ? state.data.sessionId : tempId
      session.id = realId
      if (realId !== tempId) {
        this.sessions.delete(tempId)
        this.sessions.set(realId, session)
      }
      await this.applySelection(session, config)
      return session
    } catch (error) {
      this.sessions.delete(tempId)
      this.sessions.delete(session.id)
      await this.terminateProcess(session)
      if (mcpConfigPath && existsSync(mcpConfigPath)) unlinkSync(mcpConfigPath)
      throw error
    }
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
      this.consumeStdout(session, typeof chunk === 'string' ? chunk : session.stdoutDecoder.write(chunk))
    })
    session.process.stdout.on('end', () => {
      this.consumeStdout(session, session.stdoutDecoder.end(), true)
    })
    session.process.stderr.on('data', (chunk: Buffer | string) => {
      const length = chunk.toString().trim().length
      if (length > 0) console.warn(`[PiAdapter/${session.id}] Pi wrote ${length} character(s) to stderr`)
    })
    session.process.on('error', (error) => {
      session.status = 'error'
      session.lastError = error.message
      this.rejectPending(session, error)
      this.onDataAvailable?.(session.id)
    })
    session.process.on('exit', (code, signal) => {
      if (!session.closing && session.status === 'busy') {
        session.status = 'error'
        session.lastError = `Pi exited before the turn completed (${signal || `code ${code}`})`
      }
      this.rejectPending(session, new Error(session.lastError || (session.closing ? 'Pi process closed' : 'Pi process exited')))
      this.onDataAvailable?.(session.id)
    })
  }

  private consumeStdout(session: PiSession, chunk: string, flush = false): void {
    session.stdoutBuffer += chunk
    while (true) {
      const newline = session.stdoutBuffer.indexOf('\n')
      if (newline < 0) break
      const line = session.stdoutBuffer.slice(0, newline)
      session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1)
      this.handleJsonlLine(session, line)
    }
    if (flush && session.stdoutBuffer.length > 0) {
      const line = session.stdoutBuffer
      session.stdoutBuffer = ''
      this.handleJsonlLine(session, line)
    }
  }

  private handleJsonlLine(session: PiSession, rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.trim()) return
    try {
      this.handleEvent(session, JSON.parse(line) as Record<string, unknown>)
    } catch (error) {
      console.warn('[PiAdapter] Invalid RPC output:', error)
    }
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
          return
        }
      }
      if (response.command === 'prompt' && !response.success) {
        session.status = 'error'
        session.lastError = response.error || 'Pi rejected the prompt'
      } else if (
        response.command === 'prompt'
        && response.success
        && session.promptMayBeCommandOnly
        && !session.sawAgentActivity
      ) {
        void this.command(session, { type: 'get_state' }).then((state) => {
          const pendingMessageCount = typeof state.data?.pendingMessageCount === 'number'
            ? state.data.pendingMessageCount
            : 0
          if (state.data?.isStreaming !== true && pendingMessageCount === 0 && !session.sawAgentActivity) {
            session.status = session.pendingUiRequests.size > 0 ? 'busy' : 'idle'
            this.onDataAvailable?.(session.id)
          }
        }).catch(() => undefined)
      }
      this.onDataAvailable?.(session.id)
      return
    }

    switch (event.type) {
      case 'agent_start':
        session.status = 'busy'
        session.lastError = null
        session.pendingTurnError = null
        session.pendingTurnErrorMonotonicTime = null
        session.turn++
        session.assistantMessageOrdinal = 0
        session.sawAgentActivity = true
        break
      case 'agent_settled': {
        this.cancelPendingUiRequests(session, 'This request is no longer active.')
        if (session.pendingTurnError) this.settlePendingTurnError(session)
        else session.status = 'idle'
        session.promptMayBeCommandOnly = false
        break
      }
      case 'message_start': {
        const message = event.message as PiMessage | undefined
        if (message?.role === 'assistant') session.assistantMessageOrdinal++
        break
      }
      case 'message_update':
        this.handleMessageUpdate(session, event.assistantMessageEvent as Record<string, unknown> | undefined)
        break
      case 'message_end': {
        const message = event.message as PiMessage | undefined
        this.reconcileAssistantMessage(session, message)
        if (message?.role === 'assistant' && message.stopReason === 'error') {
          session.pendingTurnError = message.errorMessage || 'Pi model request failed'
          session.pendingTurnErrorMonotonicTime = performance.now()
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
        session.pendingTurnErrorMonotonicTime = null
        break
      case 'auto_retry_end':
        session.pendingTurnError = event.success === true
          ? null
          : String(event.finalError || 'Pi retry failed')
        session.pendingTurnErrorMonotonicTime = event.success === true ? null : performance.now()
        break
      case 'compaction_end':
        if (event.result) session.pendingTurnError = null
        else if (event.aborted !== true && event.errorMessage) {
          session.parts.push({
            id: `pi-compaction-error-${session.turn}-${randomUUID()}`,
            type: MessagePartType.ERROR,
            text: String(event.errorMessage),
          })
        }
        break
      case 'extension_error':
        session.parts.push({
          id: `pi-extension-error-${randomUUID()}`,
          type: MessagePartType.ERROR,
          text: String(event.error || 'Pi extension failed'),
        })
        break
      case 'extension_ui_request':
        this.handleExtensionUiRequest(session, event)
        break
    }

    if (session.parts.length > MAX_BUFFERED_PARTS) {
      session.parts.splice(0, session.parts.length - MAX_BUFFERED_PARTS)
    }
    this.onDataAvailable?.(session.id)
  }

  private handleExtensionUiRequest(session: PiSession, event: Record<string, unknown>): void {
    const method = event.method
    const id = event.id
    if (method === 'notify') {
      const message = String(event.message || event.title || 'Pi notification')
      session.parts.push({
        id: `pi-notify-${randomUUID()}`,
        type: MessagePartType.TEXT,
        text: message,
      })
      return
    }
    if (
      typeof id !== 'string'
      || (method !== 'confirm' && method !== 'select' && method !== 'input' && method !== 'editor')
    ) return

    const request: PiUiRequest = {
      id,
      method,
      title: String(event.title || (method === 'confirm' ? 'Permission Required' : 'Input Required')),
      message: this.uiRequestMessage(method, event),
      options: Array.isArray(event.options) ? event.options.filter((option): option is string => typeof option === 'string') : [],
    }

    if (method === 'confirm' && session.config.permissionMode === 'allow') {
      this.sendRecord(session, { type: 'extension_ui_response', id, confirmed: true })
      return
    }

    session.pendingUiRequests.set(id, request)
    session.status = 'busy'
    if (method !== 'confirm') {
      session.parts.push({
        id: `pi-question-${id}`,
        type: MessagePartType.QUESTION,
        tool: {
          name: 'question',
          status: 'running',
          title: request.title,
          requestId: request.id,
          questions: [{
            header: request.title,
            question: request.message,
            options: request.options.map((label) => ({ label, description: label })),
          }],
        },
      })
    }
  }

  private uiRequestMessage(method: PiUiRequest['method'], event: Record<string, unknown>): string {
    const message = String(event.message || event.placeholder || event.title || 'Pi needs your response')
    const prefill = method === 'editor' && typeof event.prefill === 'string'
      ? event.prefill.slice(0, 2_000)
      : ''
    return prefill ? `${message}\n\nCurrent value:\n${prefill}` : message
  }

  private cancelPendingUiRequests(session: PiSession, output: string, notifyPi = false): void {
    for (const request of session.pendingUiRequests.values()) {
      if (notifyPi) {
        try {
          this.sendRecord(session, { type: 'extension_ui_response', id: request.id, cancelled: true })
        } catch {
          // The process may have closed while the turn was being stopped.
        }
      }
      session.parts.push({
        id: request.method === 'confirm' ? `question-${request.id}` : `pi-question-${request.id}`,
        type: MessagePartType.QUESTION,
        update: true,
        tool: {
          name: request.method === 'confirm' ? 'permission' : 'question',
          status: 'cancelled',
          requestId: request.id,
          output,
        },
      })
    }
    session.pendingUiRequests.clear()
  }

  private handleMessageUpdate(session: PiSession, update?: Record<string, unknown>): void {
    if (!update) return
    const index = String(update.contentIndex ?? 0)
    const key = `${session.turn}:${session.assistantMessageOrdinal}:${index}`
    if (update.type === 'text_delta') {
      const text = (session.textByBlock.get(key) || '') + String(update.delta || '')
      session.textByBlock.set(key, text)
      session.parts.push({ id: `pi-text-${key}`, type: MessagePartType.TEXT, text, update: true })
    } else if (update.type === 'text_end') {
      const text = String(update.content ?? session.textByBlock.get(key) ?? '')
      session.textByBlock.set(key, text)
      session.parts.push({ id: `pi-text-${key}`, type: MessagePartType.TEXT, text, update: true })
    } else if (update.type === 'thinking_delta') {
      const text = (session.reasoningByBlock.get(key) || '') + String(update.delta || '')
      session.reasoningByBlock.set(key, text)
      session.parts.push({ id: `pi-reasoning-${key}`, type: MessagePartType.REASONING, text, update: true })
    } else if (update.type === 'thinking_end') {
      const text = String(update.content ?? update.thinking ?? session.reasoningByBlock.get(key) ?? '')
      session.reasoningByBlock.set(key, text)
      session.parts.push({ id: `pi-reasoning-${key}`, type: MessagePartType.REASONING, text, update: true })
    }
  }

  private reconcileAssistantMessage(session: PiSession, message?: PiMessage): void {
    if (message?.role !== 'assistant') return
    const blocks = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : Array.isArray(message.content) ? message.content : []
    blocks.forEach((block, index) => {
      const key = `${session.turn}:${session.assistantMessageOrdinal}:${index}`
      if (block.type === 'text') {
        const text = String(block.text ?? '')
        session.textByBlock.set(key, text)
        session.parts.push({ id: `pi-text-${key}`, type: MessagePartType.TEXT, text, update: true })
      } else if (block.type === 'thinking') {
        const text = String(block.thinking ?? '')
        session.reasoningByBlock.set(key, text)
        session.parts.push({ id: `pi-reasoning-${key}`, type: MessagePartType.REASONING, text, update: true })
      }
    })
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

  private sendRecord(session: PiSession, record: Record<string, unknown>): void {
    if (session.process.exitCode !== null || !session.process.stdin.writable) {
      throw new Error('Pi process is not running')
    }
    session.process.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
      if (!error) return
      session.status = 'error'
      session.lastError = error.message
      this.onDataAvailable?.(session.id)
    })
  }

  async sendPrompt(sessionId: string, parts: MessagePart[], _config: SessionConfig): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const message = parts.filter((part) => part.type === MessagePartType.TEXT && part.text).map((part) => part.text).join('\n')
    if (!message) throw new Error('No text content in prompt parts')
    const wasBusy = session.status === 'busy'
    session.status = 'busy'
    session.lastError = null
    session.sawAgentActivity = false
    session.promptMayBeCommandOnly = message.trimStart().startsWith('/')
    this.sendRecord(session, {
      type: 'prompt',
      message,
      ...(wasBusy ? { streamingBehavior: 'followUp' } : {}),
    })
  }

  async getStatus(sessionId: string, _config: SessionConfig): Promise<SessionStatus> {
    const session = this.sessions.get(sessionId)
    if (!session) return { type: SessionStatusType.ERROR, message: 'Session not found' }
    // Some providers end the model stream with stopReason=error but omit the
    // final agent_settled event. Confirm Pi is no longer streaming so that a
    // terminal provider error cannot leave the task BUSY forever. A retry keeps
    // isStreaming=true (and auto_retry_start clears/replaces the pending error).
    if (
      session.pendingTurnError
      && session.pendingTurnErrorMonotonicTime !== null
      && performance.now() - session.pendingTurnErrorMonotonicTime >= TERMINAL_ERROR_SETTLE_GRACE_MS
      && session.status === 'busy'
    ) {
      try {
        const state = await this.command(session, { type: 'get_state' })
        const pendingMessageCount = typeof state.data?.pendingMessageCount === 'number'
          ? state.data.pendingMessageCount
          : 0
        if (state.data?.isStreaming !== true && pendingMessageCount === 0) {
          this.settlePendingTurnError(session)
        }
      } catch {
        // Keep polling; process exit/error handling remains authoritative.
      }
    }
    if (session.lastError) return { type: SessionStatusType.ERROR, message: session.lastError }
    if (session.pendingUiRequests.size > 0) {
      return { type: SessionStatusType.WAITING_APPROVAL, message: 'Pi is waiting for input' }
    }
    return { type: session.status === 'busy' ? SessionStatusType.BUSY : SessionStatusType.IDLE }
  }

  private settlePendingTurnError(session: PiSession): void {
    if (!session.pendingTurnError) return
    const error = session.pendingTurnError
    session.pendingTurnError = null
    session.pendingTurnErrorMonotonicTime = null
    session.lastError = error
    session.status = 'error'
    session.parts.push({
      id: `pi-error-${session.turn}`,
      type: MessagePartType.ERROR,
      text: error,
    })
  }

  async pollMessages(sessionId: string): Promise<MessagePart[]> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    return session.parts.splice(0)
  }

  getPendingApproval(sessionId: string): {
    requestId: string
    toolCallId: string
    question: string
    options: Array<{ optionId: string; name: string; kind: string }>
  } | null {
    const session = this.sessions.get(sessionId)
    const request = session
      ? Array.from(session.pendingUiRequests.values()).find((item) => item.method === 'confirm')
      : undefined
    if (!request) return null
    return {
      requestId: request.id,
      toolCallId: request.id,
      question: [request.title, request.message].filter(Boolean).join('\n\n'),
      options: [
        { optionId: 'approved', name: 'Yes', kind: 'allow_once' },
        { optionId: 'abort', name: 'No', kind: 'reject_once' },
      ],
    }
  }

  async respondToApproval(
    sessionId: string,
    approved: boolean,
    _optionId?: string,
    requestId?: string,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const request = requestId
      ? session.pendingUiRequests.get(requestId)
      : Array.from(session.pendingUiRequests.values()).find((item) => item.method === 'confirm')
    if (request?.method !== 'confirm') return false
    this.sendRecord(session, {
      type: 'extension_ui_response',
      id: request.id,
      confirmed: approved,
    })
    session.pendingUiRequests.delete(request.id)
    session.parts.push({
      id: `question-${request.id}`,
      type: MessagePartType.QUESTION,
      update: true,
      tool: {
        name: 'permission',
        status: approved ? 'completed' : 'cancelled',
        requestId: request.id,
        output: approved ? 'Approved' : 'Declined',
      },
    })
    session.status = 'busy'
    this.onDataAvailable?.(session.id)
    return true
  }

  async respondToQuestion(
    sessionId: string,
    answers: Record<string, string>,
    _config: SessionConfig,
    requestId?: string,
  ): Promise<boolean | { handled: false; resolutionPart: MessagePart }> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    const request = requestId
      ? session.pendingUiRequests.get(requestId)
      : Array.from(session.pendingUiRequests.values()).find((item) => item.method !== 'confirm')
    // A restored transcript or another client can submit a response after Pi
    // has already consumed the request. Treat that response as stale.
    if (!request || request.method === 'confirm') {
      if (!request && requestId) {
        return {
          handled: false,
          resolutionPart: {
            id: `pi-question-${requestId}`,
            type: MessagePartType.QUESTION,
            update: true,
            tool: {
              name: 'question',
              status: 'cancelled',
              requestId,
              output: 'This request expired when the session ended. Restart the turn to continue.',
            },
          },
        }
      }
      return false
    }
    const value = answers[request.title] ?? answers[request.message] ?? answers.answer ?? Object.values(answers)[0] ?? ''
    this.sendRecord(session, {
      type: 'extension_ui_response',
      id: request.id,
      value,
    })
    session.pendingUiRequests.delete(request.id)
    session.parts.push({
      id: `pi-question-${request.id}`,
      type: MessagePartType.QUESTION,
      update: true,
      tool: {
        name: 'question',
        status: 'completed',
        title: request.title,
        requestId: request.id,
        output: value,
      },
    })
    session.status = 'busy'
    this.onDataAvailable?.(session.id)
    return true
  }

  async getRunningTools(sessionId: string): Promise<Array<{
    partId: string
    toolName: string
    input?: Record<string, unknown>
  }>> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    return Array.from(session.toolParts.values()).flatMap((part) => {
      if (part.tool?.status !== 'running') return []
      return [{
        partId: part.id || `pi-tool-${part.tool.name}`,
        toolName: part.tool.name,
        ...(part.tool.input && typeof part.tool.input === 'object'
          ? { input: part.tool.input as Record<string, unknown> }
          : {}),
      }]
    })
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
    this.cancelPendingUiRequests(session, 'This request was cancelled when the turn stopped.', true)
    await this.command(session, { type: 'clear_queue' }).catch(() => undefined)
    await this.command(session, { type: 'abort' })
    session.status = 'idle'
  }

  private async terminateProcess(session: PiSession): Promise<void> {
    session.closing = true
    if (session.process.exitCode !== null || !session.process.pid) return
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(session.process.pid), '/T', '/F'], {
        timeout: 5_000,
        windowsHide: true,
      }).catch(() => session.process.kill())
      return
    }

    const processGroup = -session.process.pid
    try {
      process.kill(processGroup, 'SIGTERM')
    } catch {
      session.process.kill()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    if (session.process.exitCode !== null) return
    try {
      process.kill(processGroup, 'SIGKILL')
    } catch {
      // The process group exited during the grace period.
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    for (const request of session.pendingUiRequests.values()) {
      try {
        this.sendRecord(session, { type: 'extension_ui_response', id: request.id, cancelled: true })
      } catch {
        break
      }
    }
    session.pendingUiRequests.clear()
    await this.terminateProcess(session)
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
      const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
        timeout: 10_000,
        windowsHide: true,
      })
      const match = `${stdout}\n${stderr}`.match(/(\d+)\.(\d+)\.(\d+)/)
      if (!match) return { available: false, reason: 'Could not determine the Pi version' }
      const installed = match.slice(1, 4).map(Number)
      for (let index = 0; index < MINIMUM_PI_VERSION.length; index++) {
        if (installed[index] > MINIMUM_PI_VERSION[index]) break
        if (installed[index] < MINIMUM_PI_VERSION[index]) {
          return {
            available: false,
            reason: `Pi ${MINIMUM_PI_VERSION.join('.')} or newer is required`,
          }
        }
      }
      return { available: true }
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  async getProviders(
    _serverUrl?: string,
    directory?: string,
  ): Promise<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>; default: Record<string, string> }> {
    const executable = await this.findPiExecutable()
    const gateway = this.installPeakfloGateway()
    const config: SessionConfig = {
      agentId: 'pi-discovery',
      taskId: 'pi-discovery',
      workspaceDir: directory || process.cwd(),
      permissionMode: 'allow',
    }
    const child = spawn(executable, ['--mode', 'rpc', '--no-session', '--approve'], {
      cwd: config.workspaceDir,
      env: this.processEnv(config, gateway),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
    })
    const session = this.createSessionState(`pi-discovery-${randomUUID()}`, child, config)
    this.attachProcess(session)

    try {
      const [state, available] = await Promise.all([
        this.command(session, { type: 'get_state' }),
        this.command(session, { type: 'get_available_models' }),
      ])
      const models = Array.isArray(available.data?.models) ? available.data.models : []
      const providers = new Map<string, { id: string; name: string; models: Array<{ id: string; name: string }> }>()
      for (const model of models) {
        if (!model || typeof model !== 'object') continue
        const record = model as Record<string, unknown>
        if (typeof record.provider !== 'string' || typeof record.id !== 'string') continue
        const provider = providers.get(record.provider) ?? {
          id: record.provider,
          name: record.provider === ENTERPRISE_AI_GATEWAY_PROVIDER_ID
            ? ENTERPRISE_AI_GATEWAY_PROVIDER_NAME
            : record.provider,
          models: [],
        }
        if (!provider.models.some((item) => item.id === record.id)) {
          provider.models.push({
            id: record.id,
            name: typeof record.name === 'string' ? record.name : record.id,
          })
        }
        providers.set(record.provider, provider)
      }
      const defaultModel = state.data?.model
      const defaultProvider = defaultModel && typeof defaultModel === 'object'
        ? (defaultModel as Record<string, unknown>).provider
        : undefined
      const defaultModelId = defaultModel && typeof defaultModel === 'object'
        ? (defaultModel as Record<string, unknown>).id
        : undefined
      return {
        providers: Array.from(providers.values()),
        default: typeof defaultProvider === 'string' && typeof defaultModelId === 'string'
          ? { [defaultProvider]: defaultModelId }
          : {},
      }
    } catch (error) {
      if (!gateway) throw error
      return {
        providers: [{
          id: ENTERPRISE_AI_GATEWAY_PROVIDER_ID,
          name: ENTERPRISE_AI_GATEWAY_PROVIDER_NAME,
          models: gateway.providerModels,
        }],
        default: {},
      }
    } finally {
      await this.terminateProcess(session)
    }
  }
}
