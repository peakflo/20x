import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb } from '../../test/helpers/db-test-helper'
import { RoutineSources, collectSource } from './routine-sources'
import type { RoutineSource, McpSourceRead } from '../shared/responsibilities'

let db: ReturnType<typeof createTestDb>['db']
let dir: string
let http: Server
let url: string
let agentId: string
let serverId: string
let sources: RoutineSources
let calls: Array<{ name: string; arguments: Record<string, unknown> }>
let authHeaders: string[]
let reply: (args: Record<string, unknown>) => unknown
let toolExtra: Record<string, unknown>
let failTool: boolean
let hang: boolean
const definition = () => ({ name: 'read_records', description: 'Read records from the selected source.', inputSchema: { type: 'object', properties: { scope: { type: 'string' }, cursor: { type: 'string' } }, required: ['scope'], additionalProperties: false }, annotations: { readOnlyHint: true }, ...toolExtra })
const read = (extra: Partial<McpSourceRead> = {}): McpSourceRead => ({ kind: 'mcp', serverId, tool: 'read_records', arguments: { scope: 'approved-channel-or-page' }, description: 'Read release information', ...extra })
const plan = (r = read()): RoutineSource => ({ kind: 'collection', description: 'Watch the agreed source', reads: [r] })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), '20x-routine-sources-'))
  ;({ db } = createTestDb())
  calls = []; authHeaders = []; toolExtra = {}; failTool = false; hang = false
  reply = args => ({ results: [{ id: args.cursor ? 'second' : 'first', text: 'release ready', volatile: Date.now() }], next_cursor: args.cursor ? null : 'page-2' })
  http = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405).end(); return }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return }
    authHeaders.push(req.headers.authorization ?? '')
    let body = ''; for await (const chunk of req) body += chunk
    const message = JSON.parse(body)
    if (message.id === undefined) { res.writeHead(202).end(); return }
    if (message.method !== 'initialize' && req.headers['mcp-session-id'] !== 'source-session') { res.writeHead(400).end(); return }
    let result: unknown
    if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'source-fixture', version: '1' } }
    else if (message.method === 'tools/list') result = { tools: [definition()] }
    else if (message.method === 'tools/call') {
      calls.push(message.params)
      if (hang) return
      result = failTool ? { content: [{ type: 'text', text: 'Access denied' }], isError: true } : { content: [{ type: 'text', text: JSON.stringify(reply(message.params.arguments)) }] }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'source-session' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`
  const server = db.createMcpServer({ name: 'Independent connection', type: 'remote', url })!
  serverId = server.id
  agentId = db.createAgent({ name: 'Source reader', config: { mcp_servers: [{ serverId, enabledTools: ['read_records'] }] } })!.id
  sources = new RoutineSources(db, async () => ({ type: 'http', url, headers: { Authorization: 'Bearer fixture-token' } }))
})
afterEach(async () => {
  http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()))
  db.db.close(); rmSync(dir, { recursive: true, force: true })
})
const discover = () => sources.discover(agentId, serverId, dir, new AbortController().signal)
const collect = (p: RoutineSource, signal = new AbortController().signal) => sources.collect(p, dir, signal, agentId)

describe('configured MCP sources', () => {
  it('discovers schemas, reads every approved page with session/auth headers, and compares stable fields', async () => {
    const tools = await discover()
    expect(tools[0].inputSchema.required).toEqual(['scope'])
    const bound = sources.bind(plan(read({ pagination: { cursorArgument: 'cursor', itemsPath: '/results', nextCursorPath: '/next_cursor', maxPages: 2 }, select: ['/id', '/text'] })), agentId)
    const first = await collect(bound)
    expect(JSON.parse(first)[0].content).toEqual([{ '/id': 'first', '/text': 'release ready' }, { '/id': 'second', '/text': 'release ready' }])
    expect(await collect(bound)).toBe(first)
    expect(calls.map(c => c.arguments.cursor)).toEqual([undefined, 'page-2', undefined, 'page-2'])
    expect(authHeaders.every(h => h === 'Bearer fixture-token')).toBe(true)
    expect(JSON.stringify(sources.connections(agentId))).not.toContain('fixture-token')
  })
  it('requires discovery and rejects invalid input or disabled tools before calling a source', async () => {
    expect(() => sources.bind(plan(), agentId)).toThrow('Discover')
    await discover()
    expect(() => sources.bind(plan(read({ arguments: { missing: true } })), agentId)).toThrow('Arguments')
    db.updateAgent(agentId, { config: { mcp_servers: [{ serverId, enabledTools: [] }] } })
    expect(() => sources.bind(plan(), agentId)).toThrow('not enabled')
    expect(calls).toEqual([])
  })
  it('does not let a declared write tool become a source', async () => {
    toolExtra = { annotations: { readOnlyHint: false } }; await discover()
    expect(() => sources.bind(plan(), agentId)).toThrow('write effects')
  })
  it('invalidates changed connection and live tool definitions without widening access', async () => {
    await discover(); const bound = sources.bind(plan(), agentId)
    toolExtra = { description: 'A different operation' }
    await expect(collect(bound)).rejects.toThrow('tool changed')
    expect(calls).toEqual([])
    db.updateMcpServer(serverId, { url: `${url}/changed` })
    await expect(collect(bound)).rejects.toThrow('connection or account changed')
  })
  it('pins enterprise tenant identity but leaves normal credential refresh to the connection resolver', async () => {
    db.updateMcpServer(serverId, { source: 'enterprise' })
    db.setSetting('enterprise_user_id', 'reader'); db.setSetting('enterprise_tenant_id', 'tenant-a')
    await discover(); const bound = sources.bind(plan(), agentId)
    db.setSetting('enterprise_jwt', 'refreshed-credential')
    reply = () => ({ status: 'ok' }); expect(await collect(bound)).toContain('ok')
    db.setSetting('enterprise_tenant_id', 'tenant-b')
    await expect(collect(bound)).rejects.toThrow('connection or account changed')
  })
  it('stops waiting for connection authentication when collection is cancelled', async () => {
    sources = new RoutineSources(db, async () => new Promise(() => {}))
    const controller = new AbortController()
    const pending = sources.discover(agentId, serverId, dir, controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    controller.abort(); await rejected
    expect(calls).toHaveLength(0)
  })
  it('keeps tool errors, missing fields, and pagination limits distinct from no change', async () => {
    await discover()
    const bound = sources.bind(plan(read({ pagination: { cursorArgument: 'cursor', itemsPath: '/results', nextCursorPath: '/next_cursor', maxPages: 1 } })), agentId)
    await expect(collect(bound)).rejects.toThrow('page limit')
    reply = () => ({ results: [] })
    await expect(collect(bound)).rejects.toThrow('incomplete collection')
    failTool = true
    await expect(collect(bound)).rejects.toThrow('reported an error')
  })
  it('cancels an outstanding source call and preserves other consumers', async () => {
    await discover(); const bound = sources.bind(plan(), agentId)
    hang = true
    const controller = new AbortController()
    const pending = collect(bound, controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    controller.abort(); await rejected
    hang = false; reply = () => ({ status: 'healthy' })
    expect(await collect(bound)).toContain('healthy')
  })
  it('combines configured tools and ordinary command collectors without a provider catalog', async () => {
    await discover(); reply = () => ({ value: 'unrelated-provider' })
    const bound = sources.bind({ kind: 'collection', description: 'Combined objective', reads: [read(), { kind: 'command', command: process.execPath, args: ['-e', 'process.stdout.write("local-source")'], description: 'Local evidence' }] }, agentId)
    const value = JSON.parse(await collect(bound))
    expect(value[0].content.value).toBe('unrelated-provider')
    expect(value[1].content).toBe('local-source')
  })
  it('resolves local MCP cwd per collection and closes its own process', async () => {
    const script = join(dir, 'source.cjs')
    writeFileSync(script, `const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;
if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'local',version:'1'}};
if(m.method==='tools/list')result={tools:[${JSON.stringify(definition())}]};
if(m.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),pid:process.pid})}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`)
    db.updateMcpServer(serverId, { type: 'local', command: process.execPath, args: [script] })
    sources = new RoutineSources(db, async () => ({ type: 'stdio', command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } }))
    await discover(); const bound = sources.bind(plan(), agentId)
    const first = JSON.parse(await collect(bound))[0].content
    const secondDir = join(dir, 'another-project'); mkdirSync(secondDir)
    const second = JSON.parse(await sources.collect(bound, secondDir, new AbortController().signal, agentId))[0].content
    expect(first.cwd).toBe(realpathSync(dir)); expect(second.cwd).toBe(realpathSync(secondDir))
    expect(first.pid).not.toBe(second.pid)
    expect(() => process.kill(first.pid, 0)).toThrow()
    expect(() => process.kill(second.pid, 0)).toThrow()
  })
  it('retains legacy command behavior and normalizes JSON keys', async () => {
    const result = await collectSource({ command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({z:2,a:1}))'], description: 'Local check' }, dir, new AbortController().signal)
    expect(result).toBe('{"a":1,"z":2}')
  })
})
