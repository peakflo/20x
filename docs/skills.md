# Skills

Skills are reusable SKILL.md instructions that agents discover and load on-demand during sessions. They're stored in SQLite and written to the agent workspace at session start, so OpenCode can surface them via the `skill` tool.

## Data Model

```
Skill {
  id: string
  name: string          // ^[a-z0-9]+(-[a-z0-9]+)*$ (1-64 chars)
  description: string   // 1-1024 chars
  content: string       // markdown body
  version: number       // auto-incremented on update
  created_at, updated_at
}
```

Skills can be assigned at two levels:
- **Task-level**: `task.skill_ids` — takes priority
- **Agent-level**: `agent.config.skill_ids` — fallback
- **Unset** (both null): all skills are loaded

## SKILL.md Format

```markdown
---
name: git-release
description: Create consistent releases and changelogs
---

## What I do
- Draft release notes from merged PRs
- Propose a version bump
```

YAML frontmatter requires `name` and `description`. The directory name must match `name`.

## File Layout in Workspace

```
workspaces/<taskId>/
  .agents/
    skills/
      <skill-name>/
        SKILL.md
```

Written by `AgentManager.writeSkillFiles()` before the OpenCode session is created.

## Discovery

OpenCode discovers skills without git. It walks up from the session's working directory looking for `.agents/` (and `.claude/`, `.opencode/`) directories, then scans `skills/**/SKILL.md` inside each.

Since each task gets a unique workspace (`workspaces/<taskId>/`), OpenCode creates a fresh Instance per workspace — no caching issues for new tasks.

## Skill Resolution Priority

In `writeSkillFiles(taskId, agentId, workspaceDir)`:

1. If `task.skill_ids` is set → use those specific skills
2. Else if `agent.config.skill_ids` is set → use those
3. Else → load all skills from DB

## Feedback Learning Loop

When a user completes a task that had an active agent session:

```
User clicks "Complete Task"
  │
  ├─ No session/messages → complete immediately
  │
  └─ Has session with messages
       │
       FeedbackDialog (1-5 stars + optional comment)
       │
       ├─ Skip → complete immediately
       │
       └─ Submit
            ├─ Close dialog, mark task completed (non-blocking)
            └─ Fire-and-forget: learnFromSession(sessionId, prompt)
                 │
                 Main process:
                 1. Set learningMode (suppresses task status changes)
                 2. Send feedback prompt to agent
                 3. Agent reviews session, updates SKILL.md files
                 4. syncSkillsFromWorkspace() → compare with DB
                 5. Create/update changed skills
                 6. Clean up session
```

### learnFromSession (agent-manager.ts)

Runs entirely on the main process. The renderer fires and forgets — UI is never blocked.

- Sets `session.learningMode = true` to suppress task status changes during polling
- Sends the feedback as a prompt to the existing OpenCode session
- Awaits completion (the prompt call blocks until the agent finishes)
- Calls `syncSkillsFromWorkspace()` to sync changes back to DB
- Deletes the session

### syncSkillsFromWorkspace

Scans both `.agents/skills/` and `.opencode/skills/` (legacy) in the workspace. Handles:

- **Subdirectory layout**: `skills/<name>/SKILL.md`
- **Flat file layout**: `skills/<name>.md` (agent-created)
- **With frontmatter**: parses name + description from YAML
- **Without frontmatter**: derives name from filename (underscores → hyphens)

For each parsed skill:
- Match by name → update if content/description changed (version auto-increments)
- No match → create new skill
- Same content → skip

## IPC API

```
agentSession:syncSkills(sessionId)      → SkillSyncResult
agentSession:syncSkillsForTask(taskId)  → SkillSyncResult
agentSession:learnFromSession(sid, msg) → SkillSyncResult
```

`SkillSyncResult = { created: string[], updated: string[], unchanged: string[] }`

## UI Components

- **SkillWorkspace** — full skill management view
- **SkillList** — lists skills with CRUD
- **SkillSelector** — picker for assigning skills to tasks/agents
- **FeedbackDialog** — star rating + comment after session completion

## Files

| File | Role |
|------|------|
| `src/main/agent-manager.ts` | `writeSkillFiles`, `parseSkillMd`, `syncSkillsFromWorkspace`, `learnFromSession` |
| `src/main/database.ts` | `getSkillByName`, skill CRUD, `getSkillsByIds` |
| `src/main/ipc-handlers.ts` | IPC handlers for sync/learn |
| `src/preload/index.ts` | Bridge methods |
| `src/renderer/src/lib/ipc-client.ts` | `agentSessionApi.syncSkills`, `learnFromSession` |
| `src/renderer/src/components/tasks/FeedbackDialog.tsx` | Rating dialog |
| `src/renderer/src/components/tasks/TaskWorkspace.tsx` | Feedback orchestration |
| `src/renderer/src/components/skills/` | Skill management UI |
| `src/renderer/src/stores/skill-store.ts` | Zustand store for skills |
