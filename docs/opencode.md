# OpenCode SDK Integration - Development Summary

This document summarizes the implementation of AI agent integration with OpenCode SDK in the Workflo Workspace application.

## Overview

The implementation adds multi-agent support via the OpenCode SDK, allowing users to assign AI coding agents to tasks. Agents work on tasks, stream their progress as terminal transcripts, and pause for human approval on destructive actions (HITL - Human-in-the-Loop).

## Architecture

### Backend Components

#### 1. Agent Manager (`src/main/agent-manager.ts`)
- **Purpose**: Core orchestration layer for agent lifecycle
- **Key Features**:
  - Spawns and manages `opencode serve` process
  - Creates and manages agent sessions
  - Polls for messages from OpenCode sessions
  - Handles permission requests (HITL)
  - Forwards events to renderer via IPC
- **SDK Integration**:
  - Dynamic import of `@opencode-ai/sdk`
  - Creates OpenCode client instances per agent
  - Uses `session.create()`, `session.prompt()`, `session.messages()`, `config.providers()` APIs

#### 2. IPC Handlers (`src/main/ipc-handlers.ts`)
Extended with agent-specific handlers:
- `agentSession:start` - Start new agent session
- `agentSession:stop` - Stop active session
- `agentSession:send` - Send message to session
- `agentSession:approve` - Approve/reject permission request
- `agentConfig:getProviders` - Fetch available models from OpenCode

#### 3. Database Schema
Extended tasks table with `agent_id` column (foreign key to agents table).

### Frontend Components

#### 1. Agent Settings UI

**AgentSettingsDialog** (`src/renderer/src/components/agents/AgentSettingsDialog.tsx`)
- Modal dialog for managing agent configurations
- Lists all agents with connection test functionality
- CRUD operations (Create, Read, Update, Delete)

**AgentForm** (`src/renderer/src/components/agents/AgentForm.tsx`)
- Form for creating/editing agents
- **Fields**:
  - Name (required)
  - Server URL (OpenCode server endpoint)
  - **Coding Agent** dropdown (Opencode)
  - **Model** dropdown - Dynamically populated from OpenCode API
  - System Prompt (optional)
  - MCP Servers configuration
- **Model Fetching**:
  - Calls `client.config.providers()` via IPC
  - Handles both array and object formats for models
  - Displays models as "Provider - Model Name"
  - Falls back to manual input if fetch fails

#### 2. Task Integration

**TaskDetailView** (`src/renderer/src/components/tasks/TaskDetailView.tsx`)
- Added "Agent" field in metadata grid
- Dropdown to assign/unassign agent to task

**TaskWorkspace** (`src/renderer/src/components/tasks/TaskWorkspace.tsx`)
- Split layout: Task detail (left) + Agent Transcript (right)
- Auto-starts agent session when agent is assigned
- Stops session when task is completed/cancelled
- Manages active session state

**TaskListItem** (`src/renderer/src/components/tasks/TaskListItem.tsx`)
- Shows bot icon when agent is assigned
- Animated pulse indicator when agent is working

#### 3. Agent Session Components

**AgentTranscriptPanel** (`src/renderer/src/components/agents/AgentTranscriptPanel.tsx`)
- Streaming terminal-style output
- Monospace font with dark background
- Auto-scroll to latest message
- Status indicator (idle/working/error/waiting_approval)
- Stop button to kill session

**AgentApprovalBanner** (`src/renderer/src/components/agents/AgentApprovalBanner.tsx`)
- Fixed banner at top when permission is requested
- Shows action description
- Approve/Reject buttons
- Optional message input

**useAgentSession Hook** (`src/renderer/src/hooks/use-agent-session.ts`)
- Manages agent session state
- Subscribes to IPC events (output, status, approval)
- Provides: start, stop, sendMessage, approve
- Returns sessionId from start() for immediate use

#### 4. State Management

**Agent Store** (`src/renderer/src/stores/agent-store.ts`)
- Zustand store for agent CRUD operations
- Tracks active sessions per task
- Subscribes to agent status updates

**UI Store** (`src/renderer/src/stores/ui-store.ts`)
- Added `activeModal: 'agent-settings'` variant
- Agent settings dialog state management

### IPC Communication

#### Channels (Main → Renderer)
- `agent:output` - Agent message output
- `agent:status` - Session status changes
- `agent:approval` - Permission request

#### Channels (Renderer → Main)
- `agentSession:start` - Start session
- `agentSession:stop` - Stop session
- `agentSession:send` - Send message
- `agentSession:approve` - Respond to permission
- `agentConfig:getProviders` - Fetch models

## Key Features

### 1. Agent Assignment
- Select agent from dropdown in task detail view
- Auto-starts session when agent is assigned
- Session persists until task completion or manual stop

### 2. Model Selection
- Fetches available models from OpenCode server
- Displays all models from all providers
- Format: `provider/model-id` (e.g., `opencode/kimi-k2.5-free`)
- Graceful fallback to manual input

### 3. Real-time Transcript
- Shows agent output as it happens
- User messages (task context) shown in blue
- Assistant responses shown in dark panel
- Auto-scroll keeps latest message visible

### 4. Human-in-the-Loop (HITL)
- Agent pauses on destructive actions
- Approval banner appears at top
- User can approve/reject with optional message
- Agent continues based on decision

### 5. Session Management
- One agent per task
- Sessions are ephemeral (don't survive app restart)
- Task-agent assignment persists in database
- Cleanup on task deletion or app quit

## Technical Decisions

### 1. SDK Loading
- Dynamic import of `@opencode-ai/sdk` to handle ESM module
- Loaded once in AgentManager constructor

### 2. Polling Strategy
- Uses `session.messages()` API every 3 seconds
- More reliable than `global.event()` for message retrieval
- Parses message parts to extract text content

### 3. Message Format
- Normalized to `{ role: 'user'|'assistant'|'system', content: string }`
- Supports multiple response formats from OpenCode
- Duplicate detection prevents showing same message twice

### 4. Error Handling
- Graceful degradation when OpenCode server unavailable
- Manual model input fallback
- Error messages shown in transcript
- Session status reflects errors

### 5. Type Safety
- Full TypeScript definitions for all APIs
- Extended ElectronAPI interface
- Proper typing for IPC channels

## Known Limitations

1. **Session Persistence**: Sessions don't survive app restart (by design)
2. **Single Agent**: Only one agent per task currently supported
3. **Cost Tracking**: Not implemented in MVP
4. **Permission API**: Limited by OpenCode SDK capabilities

## Future Enhancements

- Multiple agents per task
- Session persistence across restarts
- Cost tracking per session
- Agent templates/profiles
- File attachment support in prompts
- Better error recovery and reconnection

## Files Created/Modified

### New Files
- `src/main/agent-manager.ts`
- `src/renderer/src/components/agents/AgentForm.tsx`
- `src/renderer/src/components/agents/AgentSettingsDialog.tsx`
- `src/renderer/src/components/agents/AgentTranscriptPanel.tsx`
- `src/renderer/src/components/agents/AgentApprovalBanner.tsx`
- `src/renderer/src/hooks/use-agent-session.ts`

### Modified Files
- `src/main/ipc-handlers.ts` - Added agent session handlers
- `src/main/index.ts` - Integrated AgentManager lifecycle
- `src/preload/index.ts` - Exposed agent APIs
- `src/renderer/src/components/layout/Sidebar.tsx` - Added settings button
- `src/renderer/src/components/layout/AppLayout.tsx` - Integrated agent components
- `src/renderer/src/components/tasks/TaskDetailView.tsx` - Added agent assignment
- `src/renderer/src/components/tasks/TaskWorkspace.tsx` - Split layout with transcript
- `src/renderer/src/components/tasks/TaskListItem.tsx` - Agent status indicator
- `src/renderer/src/stores/agent-store.ts` - Session tracking
- `src/renderer/src/stores/ui-store.ts` - Modal state
- `src/renderer/src/lib/ipc-client.ts` - Agent APIs
- `src/renderer/src/types/index.ts` - Agent types
- `src/renderer/src/types/electron.d.ts` - Extended ElectronAPI

## Dependencies

```json
{
  "@opencode-ai/sdk": "^1.1.53"
}
```

## Testing

### Manual Test Flow
1. Start OpenCode server (`opencode serve`)
2. Open Agent Settings (gear icon in sidebar)
3. Create new agent with:
   - Name: "Test Agent"
   - Coding Agent: Opencode
   - Model: Select from dropdown
4. Create or select a task
5. Assign agent to task
6. Verify transcript panel opens
7. Check that initial message appears
8. Wait for assistant response
9. Test stop button
10. Complete task and verify session stops

### Verification Points
- [ ] Agent settings dialog opens/closes
- [ ] Models load from OpenCode server
- [ ] Agent assignment updates task
- [ ] Session starts automatically
- [ ] Transcript shows messages
- [ ] Stop button works
- [ ] Cleanup on task completion

## References

- OpenCode SDK Documentation: https://opencode.ai/docs/sdk/
- SDK API: `client.config.providers()`, `session.create()`, `session.prompt()`, `session.messages()`
