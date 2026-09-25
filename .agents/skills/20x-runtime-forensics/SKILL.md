---
name: 20x-runtime-forensics
description: Prove or kill a bug hypothesis with the running 20x app's own state (pf-desktop.db, adapter session stores, workspace dirs, live child processes) instead of guessing, and report verified findings separately from inferred ones
confidence: 0.85
uses: 1
lastUsed: 2026-09-25
tags:
  - forensics
  - sqlite
  - pf-desktop.db
  - processes
  - evidence
---
# 20x runtime forensics

Full recipes live in `.claude/skills/20x-runtime-forensics/SKILL.md` (state paths, transcript_parts queries, timestamp footguns, the three reporting buckets).

Addition from the "failure to send a message" session:
- Also inspect live processes (`ps -eo pid,ppid,lstart,command`, `lsof -a -p <pid> -d cwd`). Parent = the 20x app pid and cwd = the task workspace ties child processes to a task. Start times spaced like user retries show a leak.
- Look up the task by `tasks.session_id` (pf-desktop.db) to map an error's thread id to a task.
- Never kill processes that may be the user's live session; ask first.
- Report what the fix does NOT cover, and say which hypothesis is still unproven.
