/**
 * Task-scoped gate in front of Cua Driver's native MCP server. Agents never
 * receive its unrestricted tools or transport. Every action is pinned to the
 * one window the user selected in 20x.
 */
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { ComputerGrant, ComputerStatus, ComputerWindow } from '../shared/computer-use'

type CuaResult = { content?: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown>; isError?: boolean }

function driverCommand(): string {
  if (process.env.CUA_DRIVER_BIN) return process.env.CUA_DRIVER_BIN
  const local = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver')
  return existsSync(local) ? local : 'cua-driver'
}

function payload(result: CuaResult): Record<string, unknown> {
  if (result.isError) throw new Error(result.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || 'Cua Driver refused the call')
  if (result.structuredContent) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  if (typeof text === 'string') {
    try { return JSON.parse(text) as Record<string, unknown> } catch { return { text } }
  }
  return {}
}

function windowsFrom(result: CuaResult): ComputerWindow[] {
  const raw = payload(result).windows
  if (!Array.isArray(raw)) return []
  return raw.filter((window): window is ComputerWindow =>
    window && typeof window === 'object' && Number.isInteger(window.pid) && Number.isInteger(window.window_id)
  ).map((window) => ({
    pid: window.pid,
    window_id: window.window_id,
    app_name: typeof window.app_name === 'string' ? window.app_name : '',
    title: typeof window.title === 'string' ? window.title : '',
    is_on_screen: window.is_on_screen === true
  }))
}

export class ComputerUseBroker {
  private client: Client | null = null
  private connecting: Promise<Client> | null = null
  private grant: ComputerGrant | null = null
  private granting = false
  private revocationVersion = 0
  private sessionTokens = new Map<string, string>()

  issueSessionToken(taskId: string): string {
    let token = this.sessionTokens.get(taskId)
    if (!token) { token = randomUUID(); this.sessionTokens.set(taskId, token) }
    return token
  }

  authorizesSession(taskId: string | null, token: string | null): boolean {
    return !!taskId && !!token && this.sessionTokens.get(taskId) === token
  }

  revokeSessionToken(taskId: string): void { this.sessionTokens.delete(taskId) }

  status(): ComputerStatus { return { grant: this.grant } }

  private async connect(): Promise<Client> {
    if (this.client) return this.client
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const client = new Client({ name: '20x-computer-use-broker', version: '1.0.0' })
      client.onclose = () => {
        if (this.client === client) { this.client = null; this.grant = null }
      }
      const transport = new StdioClientTransport({ command: driverCommand(), args: ['mcp'], stderr: 'pipe' })
      try {
        await client.connect(transport)
        this.client = client
        return client
      } catch (error) {
        await client.close().catch(() => {})
        throw new Error(`Cua Driver is unavailable. Install it and grant OS accessibility/screen-recording permissions. ${(error as Error).message}`)
      } finally { this.connecting = null }
    })()
    return this.connecting
  }

  private async call(name: string, args: Record<string, unknown>): Promise<CuaResult> {
    const client = await this.connect()
    return await client.callTool({ name, arguments: args }) as CuaResult
  }

  async listWindows(): Promise<ComputerWindow[]> {
    return windowsFrom(await this.call('list_windows', {}))
  }

  async grantWindow(taskId: string, pid: number, windowId: number): Promise<ComputerGrant> {
    if (this.grant || this.granting) throw new Error('Another task already controls a computer window. Stop it first.')
    if (!Number.isInteger(pid) || !Number.isInteger(windowId) || pid < 1 || windowId < 0) throw new Error('Invalid window')
    this.granting = true
    const version = this.revocationVersion
    try {
      const windows = windowsFrom(await this.call('list_windows', { pid }))
      if (version !== this.revocationVersion) throw new Error('Computer Use was stopped while selecting a window')
      const window = windows.find((candidate) => candidate.pid === pid && candidate.window_id === windowId)
      if (!window) throw new Error('That window is no longer available')
      if (window.app_name.toLowerCase().includes('20x')) throw new Error('20x cannot grant control of its own window')
      this.grant = { taskId, window, grantedAt: Date.now() }
      return this.grant
    } finally { this.granting = false }
  }

  async stop(taskId?: string): Promise<void> {
    if (taskId && this.grant?.taskId !== taskId) return
    this.revocationVersion++
    this.grant = null
    await this.connecting?.catch(() => {})
    const client = this.client
    this.client = null
    await client?.close().catch(() => {})
  }

  private requireGrant(taskId: string): ComputerGrant {
    if (!this.grant || this.grant.taskId !== taskId) throw new Error('Computer Use is not enabled for this task')
    return this.grant
  }

  async act(taskId: string, name: 'get_window_state' | 'click' | 'type_text' | 'press_key' | 'scroll', args: Record<string, unknown>): Promise<CuaResult> {
    const grant = this.requireGrant(taskId)
    const { pid, window_id } = grant.window
    // Re-check ownership before each action: window IDs may be recycled after a close.
    const windows = windowsFrom(await this.call('list_windows', { pid }))
    if (this.grant !== grant) throw new Error('Computer Use was stopped')
    if (!windows.some((window) => window.pid === pid && window.window_id === window_id && window.app_name === grant.window.app_name)) {
      await this.stop(taskId)
      throw new Error('The granted window closed or changed owner; Computer Use was stopped')
    }
    // The tagged target is mutually exclusive with legacy scope/pid/window_id.
    // Never forward caller-supplied routing or delivery options.
    const safeArgs = { ...args }
    for (const key of ['target', 'scope', 'pid', 'window_id', 'session', 'delivery_mode']) delete safeArgs[key]
    safeArgs.target = { kind: 'window', pid, window_id }
    safeArgs.delivery_mode = 'background'
    if (name === 'get_window_state') {
      return this.call(name, { pid, window_id, include_accessibility_tree: true, include_screenshot: true })
    }
    return this.call(name, safeArgs)
  }
}

export const computerUseBroker = new ComputerUseBroker()
export { payload as parseCuaPayload }
