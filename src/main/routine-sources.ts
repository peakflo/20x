import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/client/validators/cf-worker'
import type { DatabaseManager, McpServerRecord } from './database'
import type { McpServerConfig } from './adapters/coding-agent-adapter'
import { isSourceCollection, type CommandSource, type McpSourceRead, type RoutineSource, type SourceRead } from '../shared/responsibilities'

const execFileAsync = promisify(execFile)
const MAX_BYTES = 256 * 1024
const MAX_MS = 30000
const validator = new CfWorkerJsonSchemaValidator()
export function sourceSnapshot(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, sort(val)])) : v
  const result = typeof value === 'string' ? value : JSON.stringify(sort(value))
  if (typeof result !== 'string' || Buffer.byteLength(result) > MAX_BYTES) throw new Error('Collection exceeds the 256 KB limit. Narrow the source scope.')
  return result
}
const digest = (value: unknown): string => createHash('sha256').update(sourceSnapshot(value)).digest('hex')
function text(v: unknown, label: string, max = 12000): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || v.includes('\0')) throw new Error(`${label} must be non-empty text (maximum ${max} characters).`)
  return v
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Tool arguments must be a JSON object.')
  sourceSnapshot(v)
  return JSON.parse(JSON.stringify(v))
}
function command(v: CommandSource): CommandSource {
  if (!Array.isArray(v.args) || v.args.length > 100 || v.args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 12000)) throw new Error('Source arguments must be a list of at most 100 strings.')
  return { command: text(v.command, 'Collector executable', 2000), args: [...v.args], description: text(v.description, 'Source description') }
}
function pointer(path: unknown): string {
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/')) || path.length > 1000 || /~(?![01])/u.test(path)) throw new Error('Use a JSON pointer such as /results or /next_cursor.')
  if (path.split('/').some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) throw new Error('Unsafe JSON pointer.')
  return path
}
function at(value: unknown, path: string): unknown {
  if (!path) return value
  return path.slice(1).split('/').reduce<unknown>((v, key) => {
    key = key.replace(/~1/g, '/').replace(/~0/g, '~')
    return v && typeof v === 'object' && Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined
  }, value)
}
function project(value: unknown, paths?: string[]): unknown {
  if (!paths) return value
  return Object.fromEntries(paths.map(p => {
    const v = at(value, p)
    if (v === undefined) throw new Error(`The collected result no longer contains ${p}. Review the source.`)
    return [p, v]
  }))
}

/** Legacy command collectors remain valid without MCP or a model. */
export async function collectSource(source: RoutineSource, root: string, signal: AbortSignal): Promise<string> {
  if (isSourceCollection(source)) throw new Error('Configured source collection is unavailable in this runtime.')
  const result = await execFileAsync(source.command, source.args, { cwd: root, timeout: MAX_MS, maxBuffer: MAX_BYTES, signal, killSignal: 'SIGKILL', encoding: 'utf8' })
  const output = result.stdout.trim()
  try { return sourceSnapshot(JSON.parse(output)) } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return sourceSnapshot(output)
  }
}

/** Uses existing agent assignments and connection configuration; routines own no credentials. */
export class RoutineSources {
  private readonly catalogs = new Map<string, Tool[]>()
  constructor(private readonly db: DatabaseManager, private readonly resolveConnection: (agentId: string, serverId: string) => Promise<McpServerConfig>, private readonly connectionIdentity: (server: McpServerRecord) => unknown = () => undefined) {}

  private server(agentId: string, serverId: string, tool?: string): McpServerRecord {
    const entry = this.db.getAgent(agentId)?.config.mcp_servers?.find(e => (typeof e === 'string' ? e : e.serverId) === serverId)
    const server = this.db.getMcpServer(serverId)
    if (!entry || !server || server.name === 'task-management') throw new Error('This MCP connection is unavailable to the selected agent. Check its MCP settings.')
    if (tool && typeof entry !== 'string' && entry.enabledTools && !entry.enabledTools.includes(tool)) throw new Error('This tool is not enabled for the selected agent.')
    return server
  }
  private version(server: McpServerRecord): string {
    // OAuth token identity changes on a new login, not on normal refresh. Values never leave the auth store.
    const token = this.db.getOAuthTokenByMcpServer(server.id)
    const enterprise = server.source === 'enterprise' ? [this.db.getSetting('enterprise_user_id'), this.db.getSetting('enterprise_tenant_id')] : undefined
    return digest([server.id, server.type, server.command, server.args, server.url, server.headers, server.environment, server.source, server.oauth_metadata, token?.id, token?.scope, enterprise, this.connectionIdentity(server)])
  }
  connections(agentId: string): Array<{ serverId: string; name: string; type: string }> {
    return (this.db.getAgent(agentId)?.config.mcp_servers ?? []).flatMap(e => {
      const id = typeof e === 'string' ? e : e.serverId
      const s = this.db.getMcpServer(id)
      return s && s.name !== 'task-management' ? [{ serverId: id, name: s.name, type: s.type }] : []
    })
  }

  private async session<T>(agentId: string, serverId: string, root: string, outer: AbortSignal, run: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([outer, AbortSignal.timeout(MAX_MS)])
    signal.throwIfAborted()
    const config = await new Promise<McpServerConfig>((resolve, reject) => {
      const aborted = (): void => reject(signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
      void this.resolveConnection(agentId, serverId).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    })
    signal.throwIfAborted()
    const client = new Client({ name: '20x-routine', version: '1.0.0' }, { jsonSchemaValidator: validator })
    // A finite, dedicated session keeps pause/quit from killing another user's shared connection.
    const transport = config.type === 'stdio'
      ? new StdioClientTransport({ command: config.command!, args: config.args, env: config.env, cwd: root, stderr: 'ignore', maxBufferSize: MAX_BYTES })
      : new StreamableHTTPClientTransport(new URL(config.url!), {
        requestInit: { headers: config.headers }, onInsufficientScope: 'throw',
        fetch: async (url, init) => {
          const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) })
          if (!response.body) return response
          let bytes = 0
          const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
            bytes += chunk.byteLength
            if (bytes > MAX_BYTES) throw new Error('MCP response exceeds the 256 KB limit. Narrow the source scope.')
            controller.enqueue(chunk)
          } }))
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
        }
      })
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => closing ??= (async () => {
      const pid = transport instanceof StdioClientTransport ? transport.pid : null
      await client.close()
      if (pid) {
        const deadline = Date.now() + 1000
        while (true) {
          try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error }
          if (Date.now() >= deadline) throw new Error('The source process has not exited. Inspect its cleanup before retrying.')
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
    })()
    const aborted = (): void => { void close().catch(() => {}) }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      await client.connect(transport, { signal, timeout: MAX_MS })
      signal.throwIfAborted()
      const result = await run(client, signal)
      signal.throwIfAborted()
      return result
    } finally {
      signal.removeEventListener('abort', aborted)
      await close()
    }
  }

  private async tools(client: Client, signal: AbortSignal): Promise<Tool[]> {
    const tools: Tool[] = []; const seen = new Set<string>(); let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: MAX_MS })
      tools.push(...page.tools); sourceSnapshot(tools)
      cursor = page.nextCursor
      if (cursor && (seen.has(cursor) || seen.size >= 19)) throw new Error('Tool discovery pagination did not complete within its limit.')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return tools
  }

  async discover(agentId: string, serverId: string, root: string, signal: AbortSignal): Promise<Tool[]> {
    const s = this.server(agentId, serverId); const version = this.version(s)
    const tools = await this.session(agentId, serverId, root, signal, (c, s) => this.tools(c, s))
    if (this.version(this.server(agentId, serverId)) !== version) throw new Error('Connection changed during discovery. Try again.')
    this.catalogs.set(`${serverId}:${version}`, tools)
    return tools.filter(t => { try { this.server(agentId, serverId, t.name); return true } catch { return false } })
  }

  bind(value: RoutineSource, agentId: string): RoutineSource {
    if (!isSourceCollection(value)) return command(value)
    if (!Array.isArray(value.reads) || !value.reads.length || value.reads.length > 12) throw new Error('A collection needs 1–12 bounded reads.')
    const reads: SourceRead[] = value.reads.map(read => {
      if (read.kind === 'command') return { ...command(read), kind: 'command' }
      if (read.kind !== 'mcp') throw new Error('Choose an MCP read or a command collector.')
      const server = this.server(agentId, text(read.serverId, 'MCP connection'), text(read.tool, 'Tool name'))
      const connectionVersion = this.version(server)
      const tool = this.catalogs.get(`${server.id}:${connectionVersion}`)?.find(t => t.name === read.tool)
      if (!tool) throw new Error('Discover this connection’s tools before proposing a source read.')
      if (tool.annotations?.readOnlyHint === false) throw new Error('This tool declares write effects and cannot be used for source collection.')
      const args = object(read.arguments)
      if (!validator.getValidator(tool.inputSchema as Parameters<typeof validator.getValidator>[0])(args).valid) throw new Error(`Arguments do not match ${tool.name}. Inspect its input schema.`)
      let pagination: McpSourceRead['pagination']
      if (read.pagination) {
        const p = read.pagination
        if (!Number.isInteger(p.maxPages) || p.maxPages < 1 || p.maxPages > 20) throw new Error('Pagination must allow 1–20 pages.')
        if (!/^[\w-]+$/.test(p.cursorArgument) || ['__proto__', 'prototype', 'constructor'].includes(p.cursorArgument)) throw new Error('Pagination needs a top-level cursor argument.')
        pagination = { cursorArgument: p.cursorArgument, nextCursorPath: pointer(p.nextCursorPath), itemsPath: pointer(p.itemsPath), maxPages: p.maxPages }
      }
      if (read.select && (!Array.isArray(read.select) || !read.select.length || read.select.length > 30)) throw new Error('Select 1–30 stable JSON fields.')
      return { kind: 'mcp', serverId: server.id, serverName: server.name, tool: tool.name, arguments: args, description: text(read.description, 'Read description'),
        pagination, select: read.select?.map(pointer), connectionVersion, toolVersion: digest(tool) }
    })
    return { kind: 'collection', description: text(value.description, 'Source description'), reads, ...(value.reasoning ? { reasoning: text(value.reasoning, 'Collection reasoning') } : {}) }
  }

  validate(source: RoutineSource, agentId: string): void {
    if (!isSourceCollection(source)) return
    for (const read of source.reads) if (read.kind === 'mcp' && this.version(this.server(agentId, read.serverId, read.tool)) !== read.connectionVersion) throw new Error('The MCP connection or account changed. Revise the routine and run a new source trial.')
  }

  async collect(source: RoutineSource, root: string, signal: AbortSignal, agentId: string): Promise<string> {
    if (!isSourceCollection(source)) return collectSource(source, root, signal)
    this.validate(source, agentId)
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(60000)])
    const results: unknown[] = []
    for (const read of source.reads) {
      bounded.throwIfAborted(); this.validate(source, agentId)
      if (read.kind === 'command') results.push({ source: read.description, content: await collectSource(read, root, bounded) })
      else {
        const content = await this.session(agentId, read.serverId, root, bounded, async (client, s) => {
          const tool = (await this.tools(client, s)).find(t => t.name === read.tool)
          if (!tool || digest(tool) !== read.toolVersion) throw new Error('The source tool changed. Discover its current definition and run a new trial.')
          const items: unknown[] = []; const seen = new Set<string>(); const args = { ...read.arguments }
          for (let page = 0; page < (read.pagination?.maxPages ?? 1); page++) {
            s.throwIfAborted(); this.validate(source, agentId)
            if (!validator.getValidator(tool.inputSchema as Parameters<typeof validator.getValidator>[0])(args).valid) throw new Error('Source pagination arguments do not match the tool schema.')
            const result = await client.callTool({ name: read.tool, arguments: args }, { signal: s, timeout: MAX_MS })
            if (result.isError) throw new Error(`Source tool ${read.tool} reported an error. Check the connection and read scope.`)
            sourceSnapshot(result)
            let payload: unknown = result.structuredContent
            if (payload === undefined) {
              const content = result.content
              if (!content.every(c => c.type === 'text')) throw new Error('This source did not return comparable text or structured data.')
              const body = content.map(c => c.type === 'text' ? c.text : '').join('\n')
              try { payload = JSON.parse(body) } catch { payload = body }
            }
            if (!read.pagination) return project(payload, read.select)
            const p = read.pagination; const batch = at(payload, p.itemsPath); const cursor = at(payload, p.nextCursorPath)
            if (!Array.isArray(batch) || cursor === undefined) throw new Error('Source pagination fields are missing. This is an incomplete collection.')
            items.push(...batch.map(item => project(item, read.select))); sourceSnapshot(items)
            if (cursor === null || cursor === '') return items
            if (typeof cursor !== 'string' || seen.has(cursor)) throw new Error('The source returned an invalid or repeated cursor.')
            seen.add(cursor); args[p.cursorArgument] = cursor
          }
          throw new Error('Source pagination exceeded the approved page limit. Narrow the scope or revise the routine.')
        })
        results.push({ source: read.description, connection: read.serverName, tool: read.tool, content })
      }
      sourceSnapshot(results)
    }
    bounded.throwIfAborted(); this.validate(source, agentId)
    return sourceSnapshot(results)
  }
}
