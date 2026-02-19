# Mastermind Fixes - Complete Summary

## Issues Fixed

### 1. ❌ Auto-sends "Working on task" message → ✅ Clean start
- **Root Cause**: Session was auto-starting on panel mount AND sending initial prompt
- **Fix 1**: Removed auto-session-start on panel open
- **Fix 2**: Session only starts when user sends first message
- **Fix 3**: Pass `skipInitialPrompt: true` to prevent "Working on task mastermind-session" message

### 2. ❌ Message duplication → ✅ Single messages only
- **Root Cause**: Old session state not being cleared before starting new session
- **Fix**: Added `removeSession()` call before starting new session
- Clears old message dedup state (`seenIds`)
- Added small delay to ensure session initialization

### 3. ❌ Partial responses (stops mid-sentence) → ✅ Complete responses
- **Root Cause**: `transitionToIdle` trying to update non-existent task "mastermind-session"
- **Fix**: Added guard clause to handle non-task sessions
- No longer tries to update non-existent `mastermind-session` task
- Properly returns idle status without corrupting session

### 4. ✅ MCP Tools documented in CLAUDE.md and AGENTS.md
- Agents now see available MCP tools in their context
- Tools list includes all 7 task management tools

## Code Changes

### 1. Skip Initial Prompt for Mastermind Sessions

**Files Modified:**
- `src/main/ipc-handlers.ts`
- `src/preload/index.ts`
- `src/renderer/src/lib/ipc-client.ts`
- `src/renderer/src/hooks/use-agent-session.ts`
- `src/renderer/src/components/orchestrator/OrchestratorPanel.tsx`

**What Changed:**
The `skipInitialPrompt` parameter was added to the session start API chain and set to `true` for mastermind sessions. This prevents the auto-sent "Working on task mastermind-session" message from appearing when the session starts.

**IPC Handler** (`src/main/ipc-handlers.ts`):
```typescript
ipcMain.handle('agentSession:start', async (_, agentId, taskId, workspaceDir?, skipInitialPrompt?) => {
  const sessionId = await agentManager.startSession(agentId, taskId, workspaceDir, skipInitialPrompt)
  return { sessionId }
})
```

**Hook** (`src/renderer/src/hooks/use-agent-session.ts`):
```typescript
const start = useCallback(
  async (agentId: string, tId: string, workspaceDir?: string, skipInitialPrompt?: boolean) => {
    initSession(tId, '', agentId)
    const { sessionId } = await agentSessionApi.start(agentId, tId, workspaceDir, skipInitialPrompt)
    initSession(tId, sessionId, agentId)
    return sessionId
  },
  [initSession]
)
```

### 2. Session Start Flow

### `/src/renderer/src/components/orchestrator/OrchestratorPanel.tsx`

**Before:**
```typescript
// Auto-started session on mount
useEffect(() => {
  if (selectedAgentId && !currentSession) {
    start(selectedAgentId, ORCHESTRATOR_SESSION_ID) // ❌ Bad!
  }
}, [selectedAgentId])
```

**After:**
```typescript
// Only starts on first user message
const handleSendMessage = async (message: string) => {
  if (!currentSession?.sessionId && !startingRef.current) {
    startingRef.current = true
    removeSession(MASTERMIND_SESSION_ID)  // ✅ Clean slate
    await start(selectedAgentId, MASTERMIND_SESSION_ID, undefined, true)  // ✅ skipInitialPrompt: true
    await new Promise(resolve => setTimeout(resolve, 100))  // ✅ Wait
    await sendMessage(message)
  }
}
```

### `/src/main/agent-manager.ts`

**Fixed `transitionToIdle` method:**
```typescript
const task = this.db.getTask(session.taskId)
if (!task) {
  // ✅ Handle non-task sessions properly
  console.log(`[AgentManager] No task found for ${session.taskId}, sending idle status only`)
  this.sendToRenderer('agent:status', {
    sessionId, agentId: session.agentId, taskId: session.taskId, status: 'idle'
  })
  return  // Don't try to update task
}
```

**Added MCP tools documentation:**
- `generateAgentsMd()` - Shows MCP servers and tools in AGENTS.md
- `generateClaudeMd()` - Shows MCP tools in CLAUDE.md
- Database initialization includes tools metadata

## Testing Checklist

### Test 1: Clean Start
- [ ] Open Mastermind
- [ ] Expect: Empty chat interface, no auto-messages
- [ ] No "Working on task mastermind-session" message (neither user nor assistant)
- [ ] No session started until first user message

### Test 2: First Message
- [ ] Type: "list all tasks"
- [ ] Click send
- [ ] Expect: Session starts, message sent once
- [ ] User message appears once (blue bubble)
- [ ] Agent response appears once (gray text)

### Test 3: Complete Response
- [ ] Ask: "tell me which MCP tools do you have access to"
- [ ] Expect: Complete list of all 7 task management tools
- [ ] No mid-sentence cut-off
- [ ] Response includes: list_tasks, get_task, update_task, list_agents, list_skills, find_similar_tasks, get_task_statistics

### Test 4: Subsequent Messages
- [ ] Ask: "what tasks are pending?"
- [ ] Expect: Uses existing session (no restart)
- [ ] Response is complete
- [ ] No message duplication

### Test 5: Agent Switch
- [ ] Try to change agent dropdown while session active
- [ ] Expect: Dropdown is disabled
- [ ] Message at bottom: "(Agent selection locked during active session)"

### Test 6: Stop and Restart
- [ ] Click stop button
- [ ] Select different agent
- [ ] Send new message
- [ ] Expect: New session starts fresh, no old messages

## Known Behaviors

### Session ID
- Session ID changed: `orchestrator-session` → `mastermind-session`
- Reflects the rebrand from "Orchestrator" to "Mastermind"

### Non-Task Session
- `mastermind-session` is NOT a real task in the database
- It's a special session type for general agent chat
- Task-related operations are skipped for this session

### MCP Tools Access
- Agent has access to 7 tools:
  1. `list_tasks` - Query tasks with filters
  2. `get_task` - Get specific task details
  3. `update_task` - Modify task metadata
  4. `list_agents` - View all agents
  5. `list_skills` - View all skills
  6. `find_similar_tasks` - Pattern analysis
  7. `get_task_statistics` - Aggregated insights

## Logs to Expect

### Good Logs:
```
[AgentManager] Starting polling for session ses_xxx
[AgentManager] Session ses_xxx → idle
[AgentManager] No task found for mastermind-session, sending idle status only
[agent-store] Adding new message: { taskId: 'mastermind-session', msgId: 'xxx', role: 'user' }
[agent-store] Adding new message: { taskId: 'mastermind-session', msgId: 'yyy', role: 'assistant' }
```

### Bad Logs (Should NOT appear):
```
❌ [AgentManager] Updating task mastermind-session status to ReadyForReview
❌ [agent-store] Message already seen, skipping
❌ Working on task mastermind-session (auto-sent as initial prompt - now fixed with skipInitialPrompt)
❌ User message or agent response appearing twice
```

## If Issues Persist

### Message Duplication Still Happening
1. Check browser console for `[agent-store] Message already seen` logs
2. Verify `removeSession()` is being called
3. Check if session is being reused instead of recreated

### Responses Still Partial
1. Check logs for session transition: `Session ses_xxx → idle`
2. Verify no errors in `transitionToIdle`
3. Check if agent is hitting context limits

### Auto-Message on Open
1. Verify no `useEffect` with auto-start
2. Check if `handleSendMessage` is being called automatically
3. Look for any default message prop being passed

## Architecture Notes

### Session Flow
```
User Opens Mastermind
  ↓
Panel loads, no session starts
  ↓
User types first message
  ↓
removeSession(MASTERMIND_SESSION_ID)  ← Clean slate
  ↓
start(agentId, MASTERMIND_SESSION_ID)  ← New session
  ↓
Wait 100ms  ← Ensure initialization
  ↓
sendMessage(message)  ← Send user message
  ↓
Agent processes and responds
  ↓
Response displayed in UI
  ↓
Session transitions to idle
```

### Message Deduplication
- Uses `seenIds` Map: `taskId` → Set of message IDs
- Cleared by `removeSession()` or `clearMessageDedup()`
- Prevents duplicate messages from appearing in UI
- Handles streaming updates via `update` flag

## Files Modified

1. **src/renderer/src/components/orchestrator/OrchestratorPanel.tsx**
   - Session lifecycle management
   - Message send handler with cleanup
   - Passes `skipInitialPrompt: true` to start()

2. **src/renderer/src/hooks/use-agent-session.ts**
   - Updated `start()` to accept `skipInitialPrompt` parameter
   - Passes through to IPC API

3. **src/renderer/src/lib/ipc-client.ts**
   - Updated `agentSessionApi.start()` signature to include `skipInitialPrompt`

4. **src/preload/index.ts**
   - Updated `agentSession.start` bridge to include `skipInitialPrompt`

5. **src/main/ipc-handlers.ts**
   - Updated IPC handler to accept and pass `skipInitialPrompt`

6. **src/main/agent-manager.ts**
   - Fixed `transitionToIdle` for non-task sessions
   - Added MCP tools to CLAUDE.md generation
   - Added MCP tools to AGENTS.md generation
   - `skipInitialPrompt` already supported in both `startSession()` and `startAdapterSession()`

7. **src/main/database.ts**
   - MCP server initialization includes tools metadata
   - Mastermind skill created automatically

## Success Criteria

✅ No auto-messages on panel open
✅ User messages appear once (blue bubble)
✅ Agent messages appear once (gray text)
✅ Responses are complete (not cut off)
✅ Agent knows about MCP tools
✅ Can query tasks via chat
✅ Can switch agents (when idle)
✅ Clean session start/stop cycle

---

**Last Updated**: 2026-02-18
**Version**: 1.0 (Mastermind)
