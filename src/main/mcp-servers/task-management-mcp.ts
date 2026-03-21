import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

// Get API URL from environment (points to Electron main process HTTP server)
const apiUrl = process.env.TASK_API_URL
if (!apiUrl) {
  throw new Error('TASK_API_URL environment variable is required')
}

// Scope: if set, this MCP server is running for a subtask agent
// and can only access the parent task + its subtasks
const scopeParentId = process.env.TASK_SCOPE_PARENT_ID || null
const scopeTaskId = process.env.TASK_SCOPE_TASK_ID || null
const isScoped = !!(scopeParentId && scopeTaskId)

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
    return { error: `fetch failed: ${(err as Error).message}${causeMsg ? ` (cause: ${causeMsg})` : ''} | url=${url} | scope=${isScoped ? `task=${scopeTaskId} parent=${scopeParentId}` : 'full'}` }
  }
}

// ── Tool definitions ──────────────────────────────────────────

// Tools available in BOTH modes
const sharedTools = [
  {
    name: 'list_agents',
    description: 'List all available agents with their capabilities and configurations',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_skills',
    description: 'List all available skills with their names, descriptions, and metadata (does not include full skill content — use get_skill for that)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_skill',
    description: 'Get full details of a specific skill by ID, including its content',
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'Skill ID' }
      },
      required: ['skill_id']
    }
  },
  {
    name: 'update_skill',
    description: 'Update an existing skill. Only provided fields will be updated.',
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'Skill ID' },
        name: { type: 'string', description: 'Skill name' },
        description: { type: 'string', description: 'Skill description' },
        content: { type: 'string', description: 'Skill content (the full skill file body)' },
        confidence: { type: 'number', description: 'Confidence score (0.0 to 1.0)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' }
      },
      required: ['skill_id']
    }
  },
  {
    name: 'delete_skill',
    description: 'Delete a skill by ID (soft delete)',
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'Skill ID' }
      },
      required: ['skill_id']
    }
  }
]

// Mastermind-only tools (full access to all tasks)
const mastermindTools = [
  {
    name: 'list_tasks',
    description:
      'List all tasks with optional filters. Returns task details including title, description, status, priority, labels, agent assignment, and skills.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['not_started', 'in_progress', 'completed', 'cancelled'], description: 'Filter by task status' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Filter by priority level' },
        has_agent: { type: 'boolean', description: 'Filter tasks with/without assigned agent' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Filter by labels (tasks matching any of these labels)' },
        agent_id: { type: 'string', description: 'Filter by assigned agent ID' },
        limit: { type: 'number', default: 100, description: 'Max results to return' }
      }
    }
  },
  {
    name: 'create_task',
    description: 'Create a new task. Use the cron field for recurring tasks with standard 5-field cron syntax (minute hour day-of-month month day-of-week).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title (required)' },
        description: { type: 'string', description: 'Task description' },
        type: { type: 'string', enum: ['coding', 'manual', 'review', 'approval', 'general'], description: 'Task type' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Priority level' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Task labels' },
        assignee: { type: 'string', description: 'Person assigned to the task' },
        due_date: { type: 'string', description: 'Due date in ISO format' },
        agent_id: { type: 'string', description: 'Assign to an agent by ID (use list_agents to find IDs)' },
        skill_ids: { type: 'array', items: { type: 'string' }, description: 'Skill IDs to assign (use list_skills to find IDs)' },
        cron: { type: 'string', description: 'Cron expression for recurring tasks (e.g. "0 9 * * 1-5" for weekdays at 9am). Standard 5-field cron syntax: minute hour day-of-month month day-of-week.' }
      },
      required: ['title']
    }
  },
  {
    name: 'get_task',
    description: 'Get detailed information about a specific task by ID',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task ID' } },
      required: ['task_id']
    }
  },
  {
    name: 'update_task',
    description: 'Update task metadata. Use this to set status, resolution, description, labels, agent assignment, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        description: { type: 'string', description: 'Update task description' },
        resolution: { type: 'string', description: 'Set task resolution/output summary' },
        attachments: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' }, type: { type: 'string' } } }, description: 'Set task attachments (e.g. files, screenshots). Each item needs name and path.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Set task labels' },
        skill_ids: { type: 'array', items: { type: 'string' }, description: 'Set task skills' },
        agent_id: { type: 'string', description: 'Assign to agent' },
        repos: { type: 'array', items: { type: 'string' }, description: 'Set repository paths/URLs for this task' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        status: { type: 'string', enum: ['not_started', 'triaging', 'in_progress', 'completed', 'cancelled'] },
        output_fields: {
          type: 'array',
          description: 'Define expected output fields for this task. Each field describes a piece of structured data the agent should produce.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique identifier for this output field (e.g. "pr_url", "summary")' },
              name: { type: 'string', description: 'Human-readable name (e.g. "Pull Request URL", "Summary")' },
              type: { type: 'string', enum: ['text', 'number', 'email', 'textarea', 'list', 'date', 'file', 'boolean', 'country', 'currency', 'url'], description: 'Field type' },
              required: { type: 'boolean', description: 'Whether this output is required' },
              multiple: { type: 'boolean', description: 'Whether multiple values are allowed' },
              options: { type: 'array', items: { type: 'string' }, description: 'Options for list-type fields' }
            },
            required: ['id', 'name', 'type']
          }
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'find_similar_tasks',
    description: 'Find historical tasks similar to the given criteria using full-text search with relevance ranking. Pass individual keywords (not full sentences) for best results. Results are ranked by relevance. When completed_only returns nothing, automatically falls back to searching all tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        title_keywords: { type: 'string', description: 'Space-separated keywords to match in task titles (e.g. "login bug authentication"). Each word is matched independently.' },
        description_keywords: { type: 'string', description: 'Space-separated keywords to match in task descriptions. Each word is matched independently.' },
        type: { type: 'string', enum: ['coding', 'manual', 'review', 'approval', 'general'] },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to match (e.g. ["bug", "frontend"])' },
        completed_only: { type: 'boolean', default: false, description: 'Only return completed tasks. Defaults to false to search all tasks.' },
        limit: { type: 'number', default: 10 }
      }
    }
  },
  {
    name: 'get_task_statistics',
    description: 'Get aggregated statistics about tasks (label usage, agent workload, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['label_usage', 'agent_workload', 'priority_distribution', 'completion_rate'], description: 'Which statistic to compute' }
      },
      required: ['metric']
    }
  },
  {
    name: 'list_repos',
    description: 'List all known repositories from historical tasks and the configured GitHub organization.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'create_subtask',
    description: 'Create a subtask under a parent task. Subtasks inherit repos and priority from the parent unless specified. Each subtask can have its own agent, skills, and output fields.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_task_id: { type: 'string', description: 'The ID of the parent task' },
        title: { type: 'string', description: 'Subtask title (required)' },
        description: { type: 'string', description: 'Subtask description' },
        type: { type: 'string', enum: ['coding', 'manual', 'review', 'approval', 'general'], description: 'Subtask type' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Priority level (inherits from parent if not set)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Subtask labels' },
        agent_id: { type: 'string', description: 'Assign to an agent by ID' },
        skill_ids: { type: 'array', items: { type: 'string' }, description: 'Skill IDs to assign' },
        repos: { type: 'array', items: { type: 'string' }, description: 'Repository paths (inherits from parent if not set)' },
        output_fields: {
          type: 'array',
          description: 'Define expected output fields for this subtask. Each field describes a piece of structured data the agent should produce.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique identifier for this output field' },
              name: { type: 'string', description: 'Human-readable name' },
              type: { type: 'string', enum: ['text', 'number', 'email', 'textarea', 'list', 'date', 'file', 'boolean', 'country', 'currency', 'url'], description: 'Field type' },
              required: { type: 'boolean', description: 'Whether this output is required' },
              multiple: { type: 'boolean', description: 'Whether multiple values are allowed' },
              options: { type: 'array', items: { type: 'string' }, description: 'Options for list-type fields' }
            },
            required: ['id', 'name', 'type']
          }
        }
      },
      required: ['parent_task_id', 'title']
    }
  },
  {
    name: 'list_subtasks',
    description: 'List all subtasks for a given parent task. Returns subtask details including status, agent assignment, and outputs.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_task_id: { type: 'string', description: 'The ID of the parent task' }
      },
      required: ['parent_task_id']
    }
  }
]

// Subtask-scoped tools (can only access parent task + sibling subtasks)
const subtaskTools = [
  {
    name: 'get_parent_task',
    description: 'Get the parent task details including description, resolution, and output fields.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_own_task',
    description: 'Get this subtask\'s own details including description, resolution, attachments, and output fields.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'list_sibling_subtasks',
    description: 'List all sibling subtasks (all subtasks under the same parent). Returns status, description, resolution, and attachments for coordination.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_sibling_task',
    description: 'Get detailed information about a specific sibling subtask by ID. Only works for tasks under the same parent.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Sibling subtask ID' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'update_own_task',
    description: 'Update this subtask\'s own metadata (description, resolution, attachments, status, labels).',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Update description' },
        resolution: { type: 'string', description: 'Set resolution/output summary (read by sibling subtasks for coordination)' },
        attachments: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' }, type: { type: 'string' } } }, description: 'Set attachments (e.g. files, screenshots)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Set labels' },
        status: { type: 'string', enum: ['not_started', 'triaging', 'in_progress', 'completed', 'cancelled'], description: 'Subtask status. Note: subtasks cannot self-complete or self-cancel; set ready_for_review when done so the parent task owner can verify.' }
      }
    }
  },
  {
    name: 'update_sibling_task',
    description: 'Update a sibling subtask\'s description or attachments to pass context for coordination. Only works for tasks under the same parent.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Sibling subtask ID' },
        description: { type: 'string', description: 'Update sibling\'s description (inject context for the next subtask)' },
        attachments: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' }, type: { type: 'string' } } }, description: 'Set sibling\'s attachments' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'create_sibling_subtask',
    description: 'Create a new sibling subtask under the same parent task. Useful for breaking down work further or spawning parallel tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Subtask title' },
        description: { type: 'string', description: 'Subtask description with context and instructions' },
        agent_id: { type: 'string', description: 'Agent ID to assign (use list_agents to find available agents)' },
        skill_ids: { type: 'array', items: { type: 'string' }, description: 'Skill IDs to assign' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels for the subtask' }
      },
      required: ['title']
    }
  },
  {
    name: 'get_sibling_transcript',
    description: 'Get the conversation transcript (agent dialog) of a sibling subtask. Only works for tasks under the same parent. Returns the role and text of each message in the session. Useful for understanding what a sibling agent discussed, decided, or proposed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Sibling subtask ID whose transcript to retrieve' }
      },
      required: ['task_id']
    }
  }
]

// ── Initialize MCP server ─────────────────────────────────────

const server = new Server(
  { name: 'task-management', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// Register tool list based on mode
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: isScoped
    ? [...subtaskTools, ...sharedTools]
    : [...mastermindTools, ...sharedTools]
}))

// ── Scoped route handlers (subtask mode) ──────────────────────

async function handleScopedCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_parent_task':
      return callApi('/get_task', { task_id: scopeParentId })

    case 'get_own_task':
      return callApi('/get_task', { task_id: scopeTaskId })

    case 'list_sibling_subtasks':
      return callApi('/list_subtasks', { parent_task_id: scopeParentId })

    case 'get_sibling_task': {
      // Verify the requested task is actually a sibling
      const siblings = await callApi('/list_subtasks', { parent_task_id: scopeParentId }) as Record<string, unknown>[]
      const siblingIds = Array.isArray(siblings) ? siblings.map((s) => s.id) : []
      if (!siblingIds.includes(args.task_id)) {
        return { error: 'Access denied: task is not a sibling subtask' }
      }
      return callApi('/get_task', { task_id: args.task_id })
    }

    case 'update_own_task': {
      // Subtasks cannot self-complete or self-cancel — enforce ready_for_review ceiling
      const blockedStatuses = ['completed', 'cancelled']
      if (args.status && blockedStatuses.includes(args.status as string)) {
        return { error: `Subtasks cannot set status to "${args.status}". Use "ready_for_review" when done.` }
      }
      // Normalize MCP-style attachments ({name, path, type}) to FileAttachmentRecord format
      if (Array.isArray(args.attachments)) {
        args.attachments = (args.attachments as Record<string, unknown>[]).map((a) => ({
          id: a.id || crypto.randomUUID(),
          filename: a.name || a.filename || 'unknown',
          size: typeof a.size === 'number' ? a.size : 0,
          mime_type: a.type || a.mime_type || 'application/octet-stream',
          added_at: a.added_at || new Date().toISOString(),
          ...(a.path ? { workflo_path: a.path } : {})
        }))
      }
      return callApi('/update_task', { ...args, task_id: scopeTaskId })
    }

    case 'update_sibling_task': {
      // Verify the target is a sibling, and only allow description + attachments
      const sibs = await callApi('/list_subtasks', { parent_task_id: scopeParentId }) as Record<string, unknown>[]
      const sibIds = Array.isArray(sibs) ? sibs.map((s) => s.id) : []
      if (!sibIds.includes(args.task_id)) {
        return { error: 'Access denied: task is not a sibling subtask' }
      }
      // Only allow description and attachments updates on siblings
      const allowed: Record<string, unknown> = { task_id: args.task_id }
      if (args.description !== undefined) allowed.description = args.description
      if (args.attachments !== undefined) {
        // Normalize MCP-style attachments to FileAttachmentRecord format
        allowed.attachments = (args.attachments as Record<string, unknown>[]).map((a) => ({
          id: a.id || crypto.randomUUID(),
          filename: a.name || a.filename || 'unknown',
          size: typeof a.size === 'number' ? a.size : 0,
          mime_type: a.type || a.mime_type || 'application/octet-stream',
          added_at: a.added_at || new Date().toISOString(),
          ...(a.path ? { workflo_path: a.path } : {})
        }))
      }
      return callApi('/update_task', allowed)
    }

    case 'create_sibling_subtask':
      return callApi('/create_subtask', { ...args, parent_task_id: scopeParentId })

    case 'get_sibling_transcript': {
      // Verify the requested task is actually a sibling
      const sibsForTranscript = await callApi('/list_subtasks', { parent_task_id: scopeParentId }) as Record<string, unknown>[]
      const sibIdsForTranscript = Array.isArray(sibsForTranscript) ? sibsForTranscript.map((s) => s.id) : []
      if (!sibIdsForTranscript.includes(args.task_id)) {
        return { error: 'Access denied: task is not a sibling subtask' }
      }
      return callApi('/get_session_transcript', { task_id: args.task_id })
    }

    // Shared tools pass through directly
    default:
      return callApi(`/${name}`, args)
  }
}

// ── Tool call handler ─────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params as { name: string; arguments?: Record<string, unknown> }

  try {
    const result = isScoped
      ? await handleScopedCall(name, args || {}) as Record<string, unknown> | null
      : await callApi(`/${name}`, args || {}) as Record<string, unknown> | null

    if (result?.error) {
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: true
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  } catch (error: unknown) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: (error as Error).message }) }],
      isError: true
    }
  }
})

// Start server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`Task Management MCP server started${isScoped ? ` (scoped: task=${scopeTaskId}, parent=${scopeParentId})` : ' (full access)'}`)
}

main().catch(console.error)
