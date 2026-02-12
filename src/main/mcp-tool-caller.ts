import { spawn } from 'child_process'
import type { McpServerRecord } from './database'

export interface McpToolCallResult {
  success: boolean
  result?: unknown
  error?: string
}

export class McpToolCaller {
  private sessions = new Map<string, LocalMcpSession>()

  async callTool(
    server: McpServerRecord,
    toolName: string,
    toolArgs: Record<string, unknown> = {}
  ): Promise<McpToolCallResult> {
    console.log('[mcp] callTool:', toolName, '| server:', server.name, '| type:', server.type)
    const result = server.type === 'remote'
      ? await this.callRemoteTool(server, toolName, toolArgs)
      : await this.callLocalTool(server, toolName, toolArgs)
    if (result.success) {
      console.log('[mcp] callTool result:', toolName, JSON.stringify(result.result).slice(0, 500))
    } else {
      console.error('[mcp] callTool failed:', result.error)
    }
    return result
  }

  /** Kill a specific cached session (e.g. when server config changes) */
  killSession(serverId: string): void {
    const session = this.sessions.get(serverId)
    if (session) {
      try { session.proc.kill('SIGTERM') } catch {}
      this.sessions.delete(serverId)
    }
  }

  /** Clean up all persistent local MCP sessions */
  destroy(): void {
    for (const [id, session] of this.sessions) {
      try { session.proc.kill('SIGTERM') } catch {}
      this.sessions.delete(id)
    }
  }

  // ── Local (stdio) ───────────────────────────────────────

  private async callLocalTool(
    server: McpServerRecord,
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    if (!server.command) {
      return { success: false, error: 'No command specified' }
    }

    const session = await this.getOrCreateSession(server)
    if (!session) {
      return { success: false, error: 'Failed to initialize MCP session' }
    }

    const result = await this.sendToolCall(session, toolName, toolArgs)

    if (!result.success) {
      const isTimeout = result.error?.includes('timeout')
      if (isTimeout && session.alive) {
        // Retry once — proxy may need time after init
        console.log('[mcp] Retrying after timeout:', toolName)
        const retry = await this.sendToolCall(session, toolName, toolArgs)
        if (!retry.success) this.killSession(server.id)
        return retry
      }
      this.killSession(server.id)
    }

    return result
  }

  private async getOrCreateSession(server: McpServerRecord): Promise<LocalMcpSession | null> {
    const existing = this.sessions.get(server.id)
    if (existing && existing.alive) return existing

    // Clean up dead session
    if (existing) this.sessions.delete(server.id)

    const shellCmd = [server.command!, ...server.args]
      .map((arg) => /[\s"'\\$`!#&|;()<>]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg)
      .join(' ')

    const proc = spawn(shellCmd, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env, npm_config_yes: 'true', ...server.environment }
    })

    const session: LocalMcpSession = {
      proc,
      alive: true,
      nextId: 2,
      buffer: '',
      pending: new Map()
    }

    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      // Redact lines that may contain auth headers
      if (/authorization|bearer|token|secret|password|api[_-]?key/i.test(line)) return
      console.error('[mcp:stderr]', line)
    })

    proc.stdout.on('data', (chunk: Buffer) => {
      session.buffer += chunk.toString()
      this.drainBuffer(session)
    })

    proc.on('exit', () => {
      session.alive = false
      this.sessions.delete(server.id)
      // Reject all pending calls
      for (const [id, pending] of session.pending) {
        pending.resolve({ success: false, error: 'MCP process exited unexpectedly' })
        clearTimeout(pending.timer)
        session.pending.delete(id)
      }
    })

    proc.on('error', () => {
      session.alive = false
      this.sessions.delete(server.id)
    })

    // Initialize handshake
    const initResult = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        console.error('[mcp] Init timeout for', server.name)
        resolve(false)
      }, 30000)

      session.pending.set(1, {
        resolve: (result) => {
          clearTimeout(timer)
          if (result.success) {
            proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
            resolve(true)
          } else {
            resolve(false)
          }
        },
        timer
      })

      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'pf-desktop', version: '1.0.0' }
        }
      }) + '\n')
    })

    if (!initResult) {
      try { proc.kill('SIGTERM') } catch {}
      return null
    }

    console.log('[mcp] Session ready for', server.name)
    this.sessions.set(server.id, session)
    return session
  }

  private sendToolCall(
    session: LocalMcpSession,
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    const id = session.nextId++

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.pending.delete(id)
        resolve({ success: false, error: 'Tool call timeout (15s)' })
      }, 15000)

      session.pending.set(id, { resolve, timer })

      session.proc.stdin!.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: toolName, arguments: toolArgs }
      }) + '\n')
    })
  }

  private drainBuffer(session: LocalMcpSession): void {
    let idx: number
    while ((idx = session.buffer.indexOf('\n')) !== -1) {
      const line = session.buffer.slice(0, idx).trim()
      session.buffer = session.buffer.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        this.handleLocalMessage(session, msg)
      } catch (e) {
        console.error('[mcp] Failed to parse line:', line.slice(0, 200), e)
      }
    }
    // Try parsing remaining buffer as complete JSON (no trailing newline)
    const remaining = session.buffer.trim()
    if (remaining) {
      try {
        const msg = JSON.parse(remaining)
        session.buffer = ''
        this.handleLocalMessage(session, msg)
      } catch {
        // Incomplete JSON, wait for more data
      }
    }
  }

  private handleLocalMessage(session: LocalMcpSession, msg: JsonRpcMessage): void {
    const id = msg.id
    if (id == null) return // notification, ignore

    const pending = session.pending.get(id)
    if (!pending) return

    session.pending.delete(id)
    clearTimeout(pending.timer)

    if (msg.error) {
      pending.resolve({ success: false, error: msg.error.message || JSON.stringify(msg.error) })
    } else if (msg.result) {
      pending.resolve({ success: true, result: msg.result })
    } else {
      pending.resolve({ success: false, error: 'No result from tool call' })
    }
  }

  // ── Remote (Streamable HTTP) ────────────────────────────

  private async callRemoteTool(
    server: McpServerRecord,
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    if (!server.url) {
      return { success: false, error: 'No URL specified' }
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...server.headers
      }

      // Initialize
      const initRes = await fetch(server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pf-desktop', version: '1.0.0' } }
        }),
        signal: AbortSignal.timeout(30000)
      })

      if (!initRes.ok) {
        return { success: false, error: `HTTP ${initRes.status}: ${initRes.statusText}` }
      }

      const initMsg = await this.parseStreamableResponse(initRes)
      if (initMsg?.error) {
        return { success: false, error: initMsg.error.message || 'Initialize failed' }
      }

      // Send initialized notification (fire and forget)
      fetch(server.url, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
      }).catch(() => {})

      // Call tool
      const callRes = await fetch(server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: toolName, arguments: toolArgs }
        }),
        signal: AbortSignal.timeout(30000)
      })

      const callMsg = await this.parseStreamableResponse(callRes)
      if (callMsg?.error) {
        return { success: false, error: callMsg.error.message || 'Tool call failed' }
      }

      return { success: true, result: callMsg?.result }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Tool call failed'
      return { success: false, error: msg }
    }
  }

  /** Parse a Streamable HTTP response (JSON or SSE) */
  private async parseStreamableResponse(res: Response): Promise<JsonRpcMessage | null> {
    const contentType = res.headers.get('content-type') || ''

    // Regular JSON response
    if (contentType.includes('application/json')) {
      return res.json() as Promise<JsonRpcMessage>
    }

    // SSE response — extract last JSON-RPC message
    if (contentType.includes('text/event-stream')) {
      const text = await res.text()
      let lastMsg: JsonRpcMessage | null = null
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            lastMsg = JSON.parse(line.slice(6))
          } catch {}
        }
      }
      return lastMsg
    }

    // Fallback: try JSON
    return res.json() as Promise<JsonRpcMessage>
  }
}

// ── JSON-RPC types ───────────────────────────────────────

interface JsonRpcMessage {
  id?: number
  result?: unknown
  error?: { message: string; code?: number; data?: unknown }
}

// ── Local session types ─────────────────────────────────

interface PendingCall {
  resolve: (result: McpToolCallResult) => void
  timer: ReturnType<typeof setTimeout>
}

interface LocalMcpSession {
  proc: ReturnType<typeof spawn>
  alive: boolean
  nextId: number
  buffer: string
  pending: Map<number, PendingCall>
}
