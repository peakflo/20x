# Mastermind Implementation

## Overview

The Mastermind feature enables users to chat with agents about their tasks, get intelligent recommendations for task organization, and manage tasks through natural language commands.

## What Was Implemented

### 1. Task Management MCP Server
**File**: `src/main/mcp-servers/task-management-mcp.ts`

A Model Context Protocol (MCP) server that exposes task management tools to agents:

#### Available Tools:
- **`list_tasks`**: List tasks with filters (status, priority, agent, labels)
- **`get_task`**: Get detailed information about a specific task
- **`update_task`**: Update task metadata (labels, skills, agent assignment, priority, status)
- **`list_agents`**: List all available agents with their configurations
- **`list_skills`**: List all available skills
- **`find_similar_tasks`**: Find historical tasks based on criteria (useful for pattern analysis)
- **`get_task_statistics`**: Get aggregated statistics (label usage, agent workload, priority distribution, completion rate)

The MCP server:
- Communicates via JSON-RPC 2.0 over stdio
- Directly accesses the SQLite database (read-write mode)
- Is automatically registered with the default agent

### 2. Mastermind Panel UI
**File**: `src/renderer/src/components/orchestrator/OrchestratorPanel.tsx`

A slide-in panel that provides:
- Chat interface with any agent
- Agent selector dropdown (switch between agents)
- Persistent session management
- Full transcript view with markdown support

The panel:
- Reuses the existing `AgentTranscriptPanel` component
- Uses a special session ID: `orchestrator-session`
- Slides in from the right side of the workspace
- Can be toggled from the title bar with "Mastermind" button

### 3. AppLayout Integration
**File**: `src/renderer/src/components/layout/AppLayout.tsx`

Added:
- Toggle button in the title bar (MessageSquare icon)
- Slide-in animation for orchestrator panel
- Z-index layering to overlay workspace

### 4. Database Initialization
**File**: `src/main/database.ts`

Added `initializeTaskManagementMcpServer()` method that:
- Creates the task-management MCP server if it doesn't exist
- Automatically adds it to the default agent's configuration
- Sets the database path via environment variable

Added `initializeOrchestratorSkill()` method that:
- Creates the "Mastermind" skill in the database
- Automatically adds it to the default agent's configuration
- Teaches agents how to analyze tasks and make recommendations

### 5. Build Configuration
**File**: `electron.vite.config.ts`

Updated to build the MCP server as a separate entry point:
- Output: `out/main/mcp-servers/task-management-mcp.js`
- Bundled with all dependencies except `better-sqlite3`

## How to Use

### 1. Launch the App
```bash
pnpm dev
```

### 2. Open Mastermind
Click the **"Mastermind"** button in the title bar (top-right corner).

### 3. Chat with the Agent
Example queries:
- "What tasks are currently pending?"
- "Show me all high priority bugs"
- "List tasks assigned to Frontend Agent"
- "How many tasks does each agent have?"
- "What are the most common labels?"

### 4. Get Task Recommendations
When creating a new task, ask:
- "I just created a task: Fix payment gateway timeout. Can you analyze similar tasks and suggest labels, skills, and an agent?"

The agent will:
1. Use `find_similar_tasks` to find historical tasks
2. Analyze patterns (labels, agent assignments, skills)
3. Make recommendations
4. Optionally apply them using `update_task`

### 5. Switch Agents
Use the dropdown in the orchestrator panel header to switch between agents. Each agent may have different capabilities and configurations.

## Mastermind Skill (Automatically Created)

The "Mastermind" skill is automatically created and added to the default agent during database initialization. This skill teaches agents how to:

1. **Understand Historical Patterns**: Analyze similar tasks from history
2. **Make Recommendations**: Suggest labels, skills, agent assignments based on patterns
3. **Answer Questions**: Handle queries about tasks, agents, and workload
4. **Provide Insights**: Generate statistics about label usage, completion rates, etc.

The skill is stored in the database with:
- **Name**: "Mastermind"
- **Tags**: `mastermind`, `task-management`, `system`
- **Confidence**: 0.8 (high, since it's a system skill)

You can view or edit this skill in **Settings > Skills**.

## Architecture Notes

### MCP Server Lifecycle
- Spawned as a child process when the agent session starts
- Communicates via stdio (stdin/stdout)
- Has direct database access via `WORKFLO_DB_PATH` environment variable
- Automatically restarted if it crashes

### Session Management
- The orchestrator uses a special session ID: `orchestrator-session`
- Sessions persist across agent switches
- Old session is stopped before starting a new one

### Database Access
- The MCP server has read-write access to the SQLite database
- Uses the same database file as the main application
- Supports concurrent access via WAL mode

### Security Considerations
- MCP server only accessible to agents configured to use it
- No network exposure (stdio-based communication)
- Direct database access means agents can modify tasks

## Future Enhancements (Not Implemented)

These features were identified in the plan but not implemented yet:

1. **Auto-trigger on Task Creation**: Automatically notify the orchestrator when new tasks are created
2. **Batch Operations**: "Assign frontend skill to all UI tasks"
3. **Scheduled Task Analysis**: Periodic analysis of task patterns
4. **Notification System**: Proactive recommendations when patterns are detected
5. **Keyboard Shortcuts**: Quick toggle for orchestrator panel
6. **Preset Prompts**: Quick action buttons for common queries
7. **Task Source Integration**: Sync recommendations with external task sources

## Troubleshooting

### MCP Server Not Starting
Check logs for:
```
Error: WORKFLO_DB_PATH environment variable is required
```
This means the database path wasn't passed correctly. Verify `database.ts` initialization.

### Agent Can't See Task Management Tools
1. Check that the agent's config includes the task-management MCP server
2. Restart the agent session
3. Check MCP server logs in the agent transcript

### Build Issues
If the MCP server file is missing after build:
```bash
pnpm build
ls out/main/mcp-servers/task-management-mcp.js
```
Should exist. If not, check `electron.vite.config.ts` has the correct input configuration.

## Files Modified/Created

### New Files:
- `src/main/mcp-servers/task-management-mcp.ts` - MCP server with task management tools
- `src/renderer/src/components/orchestrator/OrchestratorPanel.tsx` - Orchestrator UI component
- `ORCHESTRATOR.md` - This documentation file

### Modified Files:
- `src/main/database.ts` - Added MCP server and Mastermind skill initialization
- `src/renderer/src/components/layout/AppLayout.tsx` - Added Mastermind panel integration
- `electron.vite.config.ts` - Added MCP server build entry point
- `package.json` - Added `@modelcontextprotocol/sdk` dependency

## Testing Checklist

- [x] Build completes successfully
- [ ] MCP server starts when default agent session starts
- [ ] Orchestrator panel opens/closes smoothly
- [ ] Agent selector switches between agents
- [ ] `list_tasks` tool returns tasks
- [ ] `get_task` tool returns task details
- [ ] `update_task` tool modifies task metadata
- [ ] `list_agents` tool returns all agents
- [ ] `list_skills` tool returns all skills
- [ ] `find_similar_tasks` tool finds historical tasks
- [ ] `get_task_statistics` tool returns aggregated stats
- [ ] Agent can make task recommendations
- [ ] Recommendations can be applied successfully
