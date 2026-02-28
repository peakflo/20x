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

async function callApi(route: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`${apiUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  })
  return res.json()
}

// Initialize MCP server
const server = new Server(
  { name: 'task-management', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
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
      description: 'Update task metadata (labels, skills, agent assignment, priority, status)',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Set task labels' },
          skill_ids: { type: 'array', items: { type: 'string' }, description: 'Set task skills' },
          agent_id: { type: 'string', description: 'Assign to agent' },
          repos: { type: 'array', items: { type: 'string' }, description: 'Set repository paths/URLs for this task' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          status: { type: 'string', enum: ['not_started', 'triaging', 'in_progress', 'completed', 'cancelled'] }
        },
        required: ['task_id']
      }
    },
    {
      name: 'list_agents',
      description: 'List all available agents with their capabilities and configurations',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'list_skills',
      description: 'List all available skills with their descriptions',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'find_similar_tasks',
      description: 'Find historical tasks similar to the given criteria. Use this to understand patterns from past task assignments.',
      inputSchema: {
        type: 'object',
        properties: {
          title_keywords: { type: 'string', description: 'Keywords to match in task title' },
          description_keywords: { type: 'string', description: 'Keywords to match in description' },
          type: { type: 'string', enum: ['coding', 'manual', 'review', 'approval', 'general'] },
          labels: { type: 'array', items: { type: 'string' } },
          completed_only: { type: 'boolean', default: true, description: 'Only return completed tasks' },
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
    }
  ]
}))

// Implement tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params as { name: string; arguments?: Record<string, unknown> }

  try {
    const result = await callApi(`/${name}`, args || {}) as Record<string, unknown> | null

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
  console.error('Task Management MCP server started')
}

main().catch(console.error)
