import { spawn } from 'child_process'
import type { McpServerRecord } from './database'

export interface McpToolCallResult {
  success: boolean
  result?: unknown
  error?: string
}

export class McpToolCaller {
  async callTool(
    server: McpServerRecord,
    toolName: string,
    toolArgs: Record<string, unknown> = {}
  ): Promise<McpToolCallResult> {
    if (server.type === 'remote') {
      return this.callRemoteTool(server, toolName, toolArgs)
    }
    return this.callLocalTool(server, toolName, toolArgs)
  }

  private callLocalTool(
    server: McpServerRecord,
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    if (!server.command) {
      return Promise.resolve({ success: false, error: 'No command specified' })
    }

    return new Promise((resolve) => {
      let resolved = false
      const finish = (result: McpToolCallResult): void => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        try { proc.kill('SIGTERM') } catch {}
        resolve(result)
      }

      const timer = setTimeout(() => {
        finish({ success: false, error: 'Tool call timeout (60s)' })
      }, 60000)

      const shellCmd = [server.command, ...server.args]
        .map((arg) => /[\s"'\\$`!#&|;()<>]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg)
        .join(' ')

      const proc = spawn(shellCmd, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: { ...process.env, npm_config_yes: 'true', ...server.environment }
      })

      let buffer = ''
      let stderrBuf = ''
      let phase: 'init' | 'call' = 'init'

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString()
      })

      const handleMessage = (msg: any): void => {
        if (msg.error) {
          finish({ success: false, error: msg.error.message || JSON.stringify(msg.error) })
          return
        }

        if (phase === 'init' && msg.id === 1 && msg.result) {
          phase = 'call'
          // Send initialized notification then call tool
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
          proc.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: toolName, arguments: toolArgs }
          }) + '\n')
        } else if (phase === 'call' && msg.id === 2) {
          if (msg.result) {
            finish({ success: true, result: msg.result })
          } else {
            finish({ success: false, error: 'No result from tool call' })
          }
        }
      }

      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        let idx: number
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          try { handleMessage(JSON.parse(line)) } catch {}
        }
        if (buffer.trim()) {
          try {
            const msg = JSON.parse(buffer.trim())
            buffer = ''
            handleMessage(msg)
          } catch {}
        }
      })

      proc.on('error', (err) => {
        finish({ success: false, error: err.message })
      })

      proc.on('exit', (code) => {
        const errMsg = stderrBuf.trim().split('\n').pop() || `Process exited with code ${code}`
        finish({ success: false, error: errMsg })
      })

      // Send initialize
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
  }

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

      const initData = await initRes.json()
      if (initData.error) {
        return { success: false, error: initData.error.message || 'Initialize failed' }
      }

      // Send initialized notification
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
        signal: AbortSignal.timeout(60000)
      })

      const callData = await callRes.json()
      if (callData.error) {
        return { success: false, error: callData.error.message || 'Tool call failed' }
      }

      return { success: true, result: callData.result }
    } catch (error: any) {
      return { success: false, error: error?.message || 'Tool call failed' }
    }
  }
}
