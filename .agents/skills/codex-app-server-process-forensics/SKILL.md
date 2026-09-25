---
name: codex-app-server-process-forensics
description: Diagnose Codex adapter errors like "thread <id> already has an active writer" on agentSession:resume — one app-server process per session, leaked processes hold the thread lock
confidence: 0.5
uses: 1
lastUsed: 2026-09-25
tags:
  - codex
  - app-server
  - resume
  - active-writer
  - process-leak
---
# Codex "already has an active writer"

**Mechanism:** `CodexAppServerAdapter` spawns one `codex app-server --stdio` per session (`startAppServerProcess`) and `resumeSession` runs `thread/resume` on a fresh process. A thread allows one writer, so any older process still holding it makes resume fail. `agent-manager.sendMessage` deliberately rethrows this error (preserves the session), so retries fail forever.

**Diagnose:**
1. `sqlite3 pf-desktop.db "select id,status,session_id from tasks where session_id='<thread id>'"`.
2. `ps -eo pid,ppid,lstart,command | grep "codex app-server"`; `lsof -a -p <pid> -d cwd` to match the task workspace. Many processes with the same cwd, parent = 20x.app, starts spaced like retries = leaked failed resumes.
3. The oldest process is the likely lock holder — unproven until tested; whether the adapter still tracks it decides if the in-adapter cleanup can kill it.

**Fix (PR #565):** kill and await the stale tracked session before resume; kill the spawned process when resume fails; retry briefly on the writer error. Known gap: an untracked orphan process is not killed — consider finding leftover app-servers by workspace cwd.

Worktree note: no node_modules; use `pnpm install --frozen-lockfile --ignore-scripts` (there is no package-lock).
