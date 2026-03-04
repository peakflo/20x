---
name: 20x-project-structure
description: Navigate the 20x Electron desktop app codebase — main process, renderer, adapters, agent management
confidence: 0.55
uses: 1
lastUsed: 2026-03-04
tags:
  - 20x
  - electron
  - project-structure
  - architecture
---

# 20x Project Structure

## Overview
20x is an Electron desktop app that integrates with multiple AI coding agents (Claude Code, Codex, OpenCode) via the ACP (Agent Client Protocol).

## Key Directories
- `src/main/` — Electron main process
- `src/main/adapters/` — Agent adapters (ACP, Claude Code, etc.)
- `src/main/agent-manager.ts` — Central session lifecycle management
- `src/renderer/` — React-based renderer
- `src/renderer/src/components/tasks/` — Task/session UI components
- `src/mobile/` — Mobile web interface

## Agent Adapter Pattern
- `coding-agent-adapter.ts` — Base interface (`CodingAgentAdapter`)
- `acp-adapter.ts` — Generic ACP protocol adapter (used by Codex, OpenCode)
- Each adapter handles: session start/resume/stop, message conversion, MCP server config

## Session Lifecycle
1. `startAdapterSession` → creates session, starts polling
2. `resumeAdapterSession` → loads session, returns messages (no polling restart needed for ACP)
3. `stopSession` → destroys session, resets status

## PR Workflow
- Branch from `main`
- Pre-commit hooks run: lint, typecheck, build
- Push to remote, create PR via `gh pr create`

## Testing
- Tests alongside source: `*.test.ts`
- Run with standard test runner
- ACP adapter tests: `src/main/adapters/acp-adapter.test.ts`
