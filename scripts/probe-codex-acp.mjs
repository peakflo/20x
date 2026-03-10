#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    timeoutMs: 15000,
    prompt: undefined,
    sessionId: undefined,
    model: undefined,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]

    if (arg === '--session-id') {
      args.sessionId = next
      i += 1
    } else if (arg === '--cwd') {
      args.cwd = next
      i += 1
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number(next)
      i += 1
    } else if (arg === '--prompt') {
      args.prompt = next
      i += 1
    } else if (arg === '--model') {
      args.model = next
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/probe-codex-acp.mjs --session-id <acpSessionId> [--cwd <dir>] [--timeout-ms <ms>]
  node scripts/probe-codex-acp.mjs --prompt "hello" [--cwd <dir>] [--model <model>] [--timeout-ms <ms>]

What it does:
- starts \`@zed-industries/codex-acp\`
- sends ACP initialize/authenticate
- either \`session/load\` an existing session or \`session/new\` + \`session/prompt\`
- logs every JSON-RPC notification and summarizes observed \`sessionUpdate\` values
`)
}

function resolveCodexAcpEntry() {
  try {
    return require.resolve('@zed-industries/codex-acp/bin/codex-acp.js')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not resolve @zed-industries/codex-acp. Run pnpm install first. Original error: ${message}`)
  }
}

class RpcClient {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.stdoutBuffer = ''
    this.notifications = []
    this.sessionUpdates = []

    child.stdout.on('data', (chunk) => {
      this.stdoutBuffer += chunk.toString()
      this.#drainStdout()
    })

    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[codex-acp stderr] ${chunk}`)
    })

    child.on('exit', (code, signal) => {
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout)
        reject(new Error(`codex-acp exited: code=${code} signal=${signal}`))
      }
      this.pending.clear()
    })
  }

  #drainStdout() {
    let newlineIndex
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (!line) continue

      let message
      try {
        message = JSON.parse(line)
      } catch (error) {
        console.error('[probe] Failed to parse line:', line)
        continue
      }

      if (Object.prototype.hasOwnProperty.call(message, 'id') && !Object.prototype.hasOwnProperty.call(message, 'method')) {
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        clearTimeout(pending.timeout)
        if (message.error) {
          pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
        } else {
          pending.resolve(message.result)
        }
        continue
      }

      if (message.method) {
        this.notifications.push(message)
        const sessionUpdate = message.params?.update?.sessionUpdate
        if (sessionUpdate) {
          this.sessionUpdates.push(sessionUpdate)
        }
        console.log(`\n[notification] ${message.method}`)
        console.log(JSON.stringify(message, null, 2))
      }
    }
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, params }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timeout })
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          clearTimeout(timeout)
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function summarize(notifications) {
  const byMethod = new Map()
  const bySessionUpdate = new Map()

  for (const note of notifications) {
    byMethod.set(note.method, (byMethod.get(note.method) || 0) + 1)
    const sessionUpdate = note.params?.update?.sessionUpdate
    if (sessionUpdate) {
      bySessionUpdate.set(sessionUpdate, (bySessionUpdate.get(sessionUpdate) || 0) + 1)
    }
  }

  console.log('\n=== Summary ===')
  console.log('Methods:')
  for (const [method, count] of byMethod.entries()) {
    console.log(`- ${method}: ${count}`)
  }

  console.log('Session updates:')
  for (const [sessionUpdate, count] of bySessionUpdate.entries()) {
    console.log(`- ${sessionUpdate}: ${count}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.sessionId && !args.prompt) {
    printHelp()
    process.exit(1)
  }

  const entry = resolveCodexAcpEntry()
  const env = { ...process.env }

  if (!env.OPENAI_API_KEY && !env.CODEX_API_KEY) {
    console.warn('[probe] Warning: OPENAI_API_KEY / CODEX_API_KEY not set; codex-acp may rely on other auth')
  }

  const child = spawn('node', [entry], {
    cwd: args.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const rpc = new RpcClient(child)

  try {
    const initResult = await rpc.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'codex-acp-probe', version: '0.0.1' }
    })

    console.log('[probe] initialize result:')
    console.log(JSON.stringify(initResult, null, 2))

    const authMethods = Array.isArray(initResult?.authMethods) ? initResult.authMethods : []
    const authMethod = authMethods.find((method) => method.id === 'openai-api-key' || method.id === 'codex-api-key') || authMethods[0]
    if (authMethod) {
      console.log(`[probe] authenticate using: ${authMethod.id}`)
      const authResult = await rpc.request('authenticate', { methodId: authMethod.id })
      console.log('[probe] authenticate result:')
      console.log(JSON.stringify(authResult, null, 2))
    }

    let sessionId = args.sessionId

    if (sessionId) {
      console.log(`[probe] loading existing session: ${sessionId}`)
      const loadResult = await rpc.request('session/load', {
        sessionId,
        cwd: args.cwd,
        mcpServers: []
      })
      console.log('[probe] session/load result:')
      console.log(JSON.stringify(loadResult, null, 2))
    } else {
      const newResult = await rpc.request('session/new', {
        cwd: args.cwd,
        mcpServers: []
      })
      console.log('[probe] session/new result:')
      console.log(JSON.stringify(newResult, null, 2))
      sessionId = newResult?.sessionId || newResult?.session_id || newResult?.id
      if (!sessionId) {
        throw new Error(`Could not extract sessionId from session/new result: ${JSON.stringify(newResult)}`)
      }

      if (args.model) {
        const setModelResult = await rpc.request('session/set_config_option', {
          sessionId,
          configId: 'model',
          value: args.model
        })
        console.log('[probe] session/set_config_option result:')
        console.log(JSON.stringify(setModelResult, null, 2))
      }

      console.log(`[probe] sending prompt into session ${sessionId}`)
      rpc.notify('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: args.prompt }]
      })
    }

    console.log(`[probe] collecting notifications for ${args.timeoutMs}ms...`)
    await sleep(args.timeoutMs)
    summarize(rpc.notifications)
    console.log(`\n[probe] observed ${rpc.notifications.length} notifications for session ${sessionId}`)
  } finally {
    child.kill('SIGTERM')
  }
}

main().catch((error) => {
  console.error('[probe] Fatal error:', error)
  process.exit(1)
})
