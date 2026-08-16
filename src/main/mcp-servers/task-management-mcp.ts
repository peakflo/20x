/**
 * Stdio entry point for the task-management MCP server.
 *
 * 20x no longer spawns this for agent sessions. Sessions use the in-process HTTP
 * endpoint instead (see task-mcp-endpoint.ts), which serves every session from
 * the process that already runs, so no child process starts and none can leak.
 *
 * This file stays for a direct run outside the app, for example
 * `TASK_API_URL=... node task-management-mcp.js`. All tool definitions and all
 * scope rules live in task-management-core.ts, so both paths behave the same.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import {
  callToolForScope,
  isScopedSession,
  listToolsForScope,
  type TaskMcpScope
} from './task-management-core'

// Get API URL from environment (points to Electron main process HTTP server)
const apiUrl = process.env.TASK_API_URL
if (!apiUrl) {
  throw new Error('TASK_API_URL environment variable is required')
}

// Scope: if set, this MCP server is running for a subtask agent
// and can only access the parent task + its subtasks.
const scope: TaskMcpScope = {
  parentTaskId: process.env.TASK_SCOPE_PARENT_ID || null,
  taskId: process.env.TASK_SCOPE_TASK_ID || null,
  // Every real task session receives this even when it needs unscoped task
  // orchestration tools. Artifact file operations are always pinned to the
  // current task so an agent cannot mutate another task's workpieces.
  artifactTaskId: process.env.TASK_ARTIFACT_SCOPE_ID || process.env.TASK_SCOPE_TASK_ID || null
}

async function callApi(route: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const url = `${apiUrl}${route}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    })
    return res.json()
  } catch (err) {
    const cause = (err as Error).cause
    const causeMsg = cause instanceof Error ? cause.message : (cause ? String(cause) : '')
    const scopeText = isScopedSession(scope) ? `task=${scope.taskId} parent=${scope.parentTaskId}` : 'full'
    return { error: `fetch failed: ${(err as Error).message}${causeMsg ? ` (cause: ${causeMsg})` : ''} | url=${url} | scope=${scopeText}` }
  }
}

const server = new Server(
  { name: 'task-management', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: listToolsForScope(scope)
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params as { name: string; arguments?: Record<string, unknown> }
  return callToolForScope(name, args, scope, callApi)
})

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  const scopeText = isScopedSession(scope)
    ? ` (scoped: task=${scope.taskId}, parent=${scope.parentTaskId})`
    : ' (full access)'
  console.error(`Task Management MCP server started${scopeText}`)
}

main().catch(console.error)
