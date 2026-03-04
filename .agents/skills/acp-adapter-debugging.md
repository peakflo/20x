---
name: acp-adapter-debugging
description: Debug and fix issues in the ACP (Agent Client Protocol) adapter for coding agents like Codex, Claude Code, OpenCode
confidence: 0.55
uses: 1
lastUsed: 2026-03-04
tags:
  - acp
  - codex
  - adapter
  - debugging
  - electron
  - agent-protocol
---

# ACP Adapter Debugging

## Key Files
- `src/main/adapters/acp-adapter.ts` — Main ACP adapter implementation
- `src/main/adapters/acp-adapter.test.ts` — Tests
- `src/main/adapters/coding-agent-adapter.ts` — Base adapter interface, `McpServerConfig`
- `src/main/agent-manager.ts` — Session lifecycle (start, resume, stop, polling)
- `src/renderer/src/components/tasks/TaskWorkspace.tsx` — Renderer panel visibility logic

## ACP Protocol Reference
- Official spec: https://agentclientprotocol.com/protocol/schema
- Rust SDK source: https://docs.rs/acp-sdk (serde-based deserialization)
- Communication: JSON-RPC over stdio
- Key RPC methods: `session/new`, `session/load`, `session/resume`

## McpServer Format (ACP Spec)
McpServers must be sent as an **array** (`Vec<McpServer>`), NOT a map/object.
- `env` → `EnvVariable[]` array of `{name, value}`, NOT `Record<string,string>`
- `headers` → `HttpHeader[]` array of `{name, value}`, NOT `Record<string,string>`
- HTTP/SSE variants need `type` discriminator field
- `args` and `env` are required fields (use `[]` as default)

## SessionUpdate Event Types
- `tool_call` — Initial tool invocation (has `toolCallId`, `title`, `kind`, `status`, `rawInput`)
- `tool_call_update` — Updates to tool (has `toolCallId`, `fields` with optional updates)
- `agent_message_chunk` — Text content from agent
- `agent_thought_chunk` — Agent reasoning/thinking content

## Codex-Specific Patterns
- **Tool name**: Codex sends tool info in `rawInput.tool` and `rawInput.server` (e.g., `codex/list_mcp_resources`) and `title` (e.g., `Tool: codex/list_mcp_resources`), NOT in `kind`
- **Tool output**: `rawOutput` has format `{content: [{text, type}], isError}` — need to extract from content array
- **Tool input**: Can be in `rawInput.command` (string or string[]) or `rawInput.parsed_cmd[].cmd`
- **Name fallback chain**: `kind > rawInput.tool (with server prefix) > title (strip "Tool: ") > cachedMeta > 'tool'`

## Session Resume Flow
1. `resumeAdapterSession` in agent-manager calls adapter's `resumeSession`
2. During `session/load`, Codex replays history as notifications buffered in adapter
3. `resumeSession` must return actual messages (via `getAllMessages()`), NOT empty array
4. Renderer hides panel when `status === 'idle' && messages.length === 0`

## Turn Detection
- Time-gap based: 2-second threshold between chunks triggers new turn
- Tool calls between text chunks should NOT split messages into separate turns
- Use `toolCallMetadata` Map to cache tool info from initial events for completed events

## Common Pitfalls
- Codex uses Rust serde: strict type checking — maps vs arrays matter
- Pre-commit hooks may fail on pre-existing errors in other files (e.g., `mobile-api-server.test.ts`)
- Different agents (Claude Code, OpenCode, Codex) have different event field conventions
