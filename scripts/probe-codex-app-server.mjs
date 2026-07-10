#!/usr/bin/env node

/**
 * Non-model Codex App Server probe.
 *
 * This validates the local app-server protocol path without sending a turn or
 * prompt. It exercises:
 * - process startup over stdio
 * - initialize / initialized
 * - thread/start without a model turn, followed by thread/delete cleanup
 * - thread/read
 * - thread/items/list with thread/turns/list fallback
 *
 * Usage:
 *   node scripts/probe-codex-app-server.mjs [--cwd <dir>] [--timeout-ms <ms>]
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)

function argValue(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  return args[index + 1] ?? fallback
}

const cwd = resolve(argValue('--cwd', process.cwd()))
const timeoutMs = Number(argValue('--timeout-ms', '20000'))

if (!existsSync(cwd)) {
  throw new Error(`cwd does not exist: ${cwd}`)
}

const env = { ...process.env }
delete env.OPENAI_API_KEY
delete env.CODEX_API_KEY

const child = spawn('codex', ['app-server', '--stdio'], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  // Keep this probe on the user's existing Codex login path. Do not inject API
  // keys here; the probe should match subscription/CLI-login app behavior.
  env
})

let nextId = 1
let stdoutBuffer = ''
const pending = new Map()
const notifications = []
const serverRequests = []

const timeout = setTimeout(() => {
  child.kill('SIGTERM')
  throw new Error(`Probe timed out after ${timeoutMs}ms`)
}, timeoutMs)

function write(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function request(method, params) {
  const id = nextId++
  write({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, method })
  })
}

function notify(method, params = {}) {
  write({ jsonrpc: '2.0', method, params })
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function handleMessage(message) {
  if ('id' in message && 'method' in message) {
    serverRequests.push(message.method)
    if (message.method === 'currentTime/read') {
      respond(message.id, { nowMs: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      return
    }
    respond(message.id, {})
    return
  }

  if ('id' in message) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) {
      entry.reject(new Error(`${entry.method}: ${message.error.message}`))
    } else {
      entry.resolve(message.result)
    }
    return
  }

  if (message.method) {
    notifications.push(message.method)
  }
}

child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString()
  let newlineIndex
  while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim()
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
    if (!line) continue
    handleMessage(JSON.parse(line))
  }
})

child.stderr.on('data', (chunk) => {
  process.stderr.write(`[codex app-server stderr] ${chunk}`)
})

child.on('exit', (code, signal) => {
  for (const entry of pending.values()) {
    entry.reject(new Error(`codex app-server exited: code=${code} signal=${signal}`))
  }
  pending.clear()
})

try {
  const init = await request('initialize', {
    clientInfo: { name: '20x-app-server-probe', version: '0.0.1', title: '20x App Server Probe' },
    capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true }
  })
  notify('initialized')

  const started = await request('thread/start', {
    cwd,
    ephemeral: false,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    runtimeWorkspaceRoots: [cwd],
    threadSource: '20x-probe'
  })

  const threadId = started?.thread?.id || started?.threadId || started?.id
  if (!threadId) {
    throw new Error(`thread/start did not return a thread id: ${JSON.stringify(started)}`)
  }

  const read = await request('thread/read', { threadId })
  let historyMethod = 'thread/items/list'
  let history
  let historyUnavailableReason = null
  try {
    history = await request('thread/items/list', { threadId, limit: 20, sortDirection: 'asc' })
  } catch (error) {
    if (!String(error?.message || error).includes('not supported')) throw error
    historyMethod = 'thread/turns/list'
    try {
      history = await request('thread/turns/list', { threadId, limit: 20, sortDirection: 'asc', itemsView: 'full' })
    } catch (turnsError) {
      const message = String(turnsError?.message || turnsError)
      if (!message.includes('not materialized yet') && !message.includes('before first user message')) {
        throw turnsError
      }
      historyUnavailableReason = message
      history = { data: [] }
    }
  }

  console.log(JSON.stringify({
    ok: true,
    codexHome: init?.codexHome,
    userAgent: init?.userAgent,
    threadId,
    model: started?.model,
    modelProvider: started?.modelProvider,
    readHasThread: Boolean(read?.thread || read?.id || read?.threadId),
    historyMethod,
    historyCount: Array.isArray(history?.data) ? history.data.length : null,
    historyUnavailableReason,
    notifications: [...new Set(notifications)].sort(),
    serverRequests: [...new Set(serverRequests)].sort()
  }, null, 2))

  await request('thread/delete', { threadId })
} finally {
  clearTimeout(timeout)
  child.kill('SIGTERM')
}
