# 20x Mobile API Specification

> HTTP + WebSocket API served by the Electron main process for mobile clients.
> Default port: `20620`, bound to `0.0.0.0` for Tailscale/LAN access.

---

## Table of Contents

- [Authentication](#authentication)
- [REST API](#rest-api)
  - [Tasks](#tasks)
  - [Agents](#agents)
  - [Harness Maintenance](#harness-maintenance)
  - [Agent Sessions](#agent-sessions)
- [WebSocket API](#websocket-api)
  - [Connection](#connection)
  - [Events: Server → Client](#events-server--client)
- [Type Definitions](#type-definitions)

---

## Authentication

All requests (HTTP and WebSocket) require a bearer token when mobile auth is enabled.

```
Authorization: Bearer <token>
```

For WebSocket connections, pass the token as a query parameter:

```
ws://<host>:20620/ws?token=<token>
```

The token is configured in Settings → General → Mobile Access.

---

## REST API

All endpoints accept and return `application/json`.
All timestamps are ISO 8601 strings (e.g., `"2026-03-01T12:00:00.000Z"`).

### Common Response Envelope

Success responses return the data directly.
Error responses return:
```json
{ "error": "Human-readable error message" }
```
with an appropriate HTTP status code (400, 404, 500).

---

### Tasks

#### `GET /api/tasks`

List all tasks with optional filters.

**Query Parameters:**

| Param      | Type     | Default | Description |
|------------|----------|---------|-------------|
| `status`   | `string` | —       | Filter by TaskStatus value (e.g., `not_started`, `agent_working`) |
| `priority` | `string` | —       | Filter by priority (`critical`, `high`, `medium`, `low`) |
| `source`   | `string` | —       | Filter by source name (e.g., `local`, `linear`) |
| `search`   | `string` | —       | Search title and description (case-insensitive LIKE) |
| `sort`     | `string` | `created_at` | Sort field: `created_at`, `updated_at`, `priority`, `status`, `due_date`, `title` |
| `order`    | `string` | `desc`  | Sort direction: `asc` or `desc` |

**Response:** `200 OK`

```json
[
  {
    "id": "clxyz123abc",
    "title": "Implement login page",
    "description": "Build the login page with OAuth support",
    "type": "coding",
    "priority": "high",
    "status": "agent_working",
    "assignee": "",
    "due_date": "2026-03-15T00:00:00.000Z",
    "labels": ["frontend", "auth"],
    "attachments": [],
    "repos": ["peakflo/20x"],
    "output_fields": [],
    "agent_id": "agent_abc123",
    "session_id": "session_xyz789",
    "external_id": null,
    "source_id": null,
    "source": "local",
    "skill_ids": ["skill_1"],
    "snoozed_until": null,
    "resolution": null,
    "feedback_rating": null,
    "feedback_comment": null,
    "is_recurring": false,
    "recurrence_pattern": null,
    "recurrence_parent_id": null,
    "last_occurrence_at": null,
    "next_occurrence_at": null,
    "created_at": "2026-02-28T10:00:00.000Z",
    "updated_at": "2026-03-01T08:30:00.000Z"
  }
]
```

---

#### `GET /api/tasks/:id`

Get a single task by ID.

**Path Parameters:**

| Param | Type     | Description |
|-------|----------|-------------|
| `id`  | `string` | Task ID     |

**Response:** `200 OK` — Single `Task` object (same shape as list item above)

**Error:** `404` — `{ "error": "Task not found" }`

---

#### `POST /api/tasks/:id`

Update a task. Only provided fields are updated.

**Path Parameters:**

| Param | Type     | Description |
|-------|----------|-------------|
| `id`  | `string` | Task ID     |

**Request Body:** `UpdateTaskDTO`

```json
{
  "title": "Updated title",
  "description": "New description",
  "type": "coding",
  "priority": "critical",
  "status": "not_started",
  "assignee": "dmitry",
  "due_date": "2026-03-20T00:00:00.000Z",
  "labels": ["urgent", "backend"],
  "repos": ["peakflo/20x"],
  "output_fields": [
    {
      "id": "field_1",
      "name": "PR URL",
      "type": "url",
      "required": true,
      "value": null
    }
  ],
  "resolution": "Completed via PR #42",
  "agent_id": "agent_abc123",
  "skill_ids": ["skill_1", "skill_2"],
  "snoozed_until": "2026-03-05T09:00:00.000Z",
  "feedback_rating": 5,
  "feedback_comment": "Great work"
}
```

**All fields are optional.** Only include what you want to change.

| Field               | Type                          | Description |
|---------------------|-------------------------------|-------------|
| `title`             | `string`                      | Task title |
| `description`       | `string`                      | Markdown description |
| `type`              | `TaskType`                    | `coding`, `manual`, `review`, `approval`, `general` |
| `priority`          | `TaskPriority`                | `critical`, `high`, `medium`, `low` |
| `status`            | `TaskStatus`                  | See [TaskStatus enum](#taskstatus) |
| `assignee`          | `string`                      | Assignee display name |
| `due_date`          | `string \| null`              | ISO 8601 date or null to clear |
| `labels`            | `string[]`                    | Full replacement of labels array |
| `attachments`       | `FileAttachment[]`            | Full replacement of attachments array |
| `repos`             | `string[]`                    | GitHub repo full names (`owner/repo`) |
| `output_fields`     | `OutputField[]`               | Full replacement of output fields |
| `resolution`        | `string \| null`              | Completion notes |
| `agent_id`          | `string \| null`              | Assign/unassign agent |
| `skill_ids`         | `string[] \| null`            | Override skills (null = agent defaults) |
| `snoozed_until`     | `string \| null`              | ISO 8601 snooze end; `"9999-12-31T00:00:00.000Z"` = "Someday" |
| `feedback_rating`   | `number \| null`              | 1–5 star rating |
| `feedback_comment`  | `string \| null`              | Feedback text |
| `is_recurring`      | `boolean`                     | Toggle recurring |
| `recurrence_pattern`| `RecurrencePattern \| null`   | Cron string or pattern object |

**Response:** `200 OK` — Updated `Task` object

**Error:** `404` — `{ "error": "Task not found" }`

---

### Agents

#### `GET /api/agents`

List all configured agents.

**Response:** `200 OK`

```json
[
  {
    "id": "agent_abc123",
    "name": "Claude Coder",
    "server_url": "http://localhost:4096",
    "config": {
      "coding_agent": "claude-code",
      "model": "claude-opus-4-6",
      "system_prompt": "",
      "mcp_servers": ["mcp_server_1", { "serverId": "mcp_server_2", "enabledTools": ["tool_a"] }],
      "skill_ids": ["skill_1"],
      "secret_ids": ["secret_1"],
      "api_keys": {
        "anthropic": "sk-..."
      }
    },
    "is_default": true,
    "created_at": "2026-01-15T10:00:00.000Z",
    "updated_at": "2026-02-28T14:00:00.000Z"
  }
]
```

---

#### `GET /api/agents/:id`

Get a single agent by ID.

**Path Parameters:**

| Param | Type     | Description |
|-------|----------|-------------|
| `id`  | `string` | Agent ID    |

**Response:** `200 OK` — Single `Agent` object

**Error:** `404` — `{ "error": "Agent not found" }`

---

### Harness Maintenance

Version checks and user-triggered updates for installed harness CLIs (Claude Code, Codex, OpenCode, Pi). Cursor is included read-only — it either shows "Updates with 20x" or is manual-only, depending on which Cursor integration is live. Updates run on the desktop host the phone is paired to; the mobile client never runs anything itself.

#### `GET /api/harness-maintenance`

List the current maintenance status of every harness.

**Response:** `200 OK`

```json
[
  {
    "harness": "codex",
    "installed": true,
    "binaryPath": "/Users/dev/.local/bin/codex",
    "version": "0.18.0",
    "latestVersion": "0.20.0",
    "status": "behind_latest",
    "installer": "native",
    "canUpdate": true,
    "updateCommand": "codex update",
    "checkedAt": "2026-03-01T12:00:00.000Z",
    "hasActiveSession": false
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `harness` | `string` | `claude-code`, `codex`, `opencode`, `pi`, or `cursor` |
| `installed` | `boolean` | Whether the CLI was found |
| `binaryPath` | `string \| null` | Resolved (symlink-followed) path to the binary |
| `version` | `string \| null` | Installed version, parsed from `--version` |
| `latestVersion` | `string \| null` | Latest published version, or `null` if checks are off/offline/failed |
| `status` | `string` | `up_to_date`, `behind_latest`, `below_recommended`, `unsupported`, `not_installed`, or `unknown` |
| `installer` | `string` | How the binary got there — `native`, `npm-global`, `pnpm-global`, `yarn-global`, `bun-global`, `homebrew-formula`, `homebrew-cask`, `manual`, or `bundled` (Cursor, updates with 20x) |
| `canUpdate` | `boolean` | Whether `update` can run one-click, vs. a manual command |
| `updateCommand` | `string \| null` | Human-readable update command, for display/copy |
| `checkedAt` | `string` | ISO 8601 timestamp of this result |
| `error` | `string?` | Set when the latest-version lookup itself failed |
| `hasActiveSession` | `boolean?` | A session of this harness is running — it keeps the old binary until restarted |

---

#### `POST /api/harness-maintenance/refresh`

Re-checks every harness.

**Request Body:**

```json
{ "fresh": true }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fresh` | `boolean` | No | Bypasses the npm/Homebrew latest-version cache |

**Response:** `200 OK` — array of `HarnessMaintenanceStatus` (same shape as the GET above)

---

#### `POST /api/harness-maintenance/update`

Updates one harness. Always triggered by an explicit tap — never automatic.

**Request Body:**

```json
{ "harness": "codex" }
```

**Response:** `200 OK`

```json
{
  "harness": "codex",
  "run": {
    "harness": "codex",
    "status": "succeeded",
    "message": "Updated.",
    "startedAt": "2026-03-01T12:00:00.000Z",
    "finishedAt": "2026-03-01T12:00:05.000Z"
  },
  "newStatus": { "...": "HarnessMaintenanceStatus, re-checked after the update" }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `run.status` | `string` | `queued`, `running`, `succeeded`, `failed`, or `unchanged` |
| `run.message` | `string?` | Human-readable result, e.g. "Restart running tasks to use the new version." |
| `run.output` | `string?` | Captured stdout/stderr, present on failure |

**Error:** `400` — `harness` is required. A harness with no one-click update (manual-only) returns a `failed` run with a message, not an HTTP error.

---

#### `POST /api/harness-maintenance/update-all`

Updates every harness with `canUpdate`, sequentially per installer lock. Manual-only harnesses are skipped.

**Response:** `200 OK`

```json
{
  "results": [{ "harness": "codex", "run": { "...": "..." }, "newStatus": { "...": "..." } }],
  "skipped": ["cursor"]
}
```

---

### Skills

#### `GET /api/skills`

List all configured skills (available to agents).

**Response:** `200 OK`

```json
[
  {
    "id": "skill_abc123",
    "name": "Code Review",
    "description": "Reviews pull requests",
    "agent_id": "agent_abc123"
  }
]
```

| Field       | Type            | Description |
|-------------|-----------------|-------------|
| `id`        | `string`        | Skill ID |
| `name`      | `string`        | Display name |
| `description`| `string`       | What the skill does |
| `agent_id`  | `string \| null`| Agent this skill belongs to (null = available to all) |

---

### GitHub

#### `GET /api/github/org`

Get the configured GitHub organization name.

**Response:** `200 OK`

```json
{
  "org": "peakflo"
}
```

| Field | Type     | Description |
|-------|----------|-------------|
| `org` | `string` | GitHub org name (empty string if not configured) |

---

#### `POST /api/github/repos`

Fetch repositories for a GitHub organization.

**Request Body:**

```json
{
  "org": "peakflo"
}
```

| Field | Type     | Required | Description |
|-------|----------|----------|-------------|
| `org` | `string` | Yes      | GitHub organization name |

**Response:** `200 OK`

```json
[
  {
    "name": "20x",
    "fullName": "peakflo/20x",
    "defaultBranch": "main",
    "cloneUrl": "https://github.com/peakflo/20x.git",
    "description": "AI agent platform",
    "isPrivate": true
  }
]
```

**Error:** `400` — `org` is required. `500` — GitHub not configured.

---

### Agent Sessions

#### `GET /api/sessions`

List all active agent sessions.

**Response:** `200 OK`

```json
[
  {
    "sessionId": "sess_abc123",
    "agentId": "agent_abc123",
    "taskId": "clxyz123abc",
    "status": "working"
  }
]
```

| Field       | Type             | Description |
|-------------|------------------|-------------|
| `sessionId` | `string`         | Internal session ID |
| `agentId`   | `string`         | Agent that owns this session |
| `taskId`    | `string`         | Task this session is working on |
| `status`    | `SessionStatus`  | `idle`, `working`, `error`, `waiting_approval` |

---

#### `POST /api/sessions/start`

Start a new agent session for a task.

**Request Body:**

```json
{
  "agentId": "agent_abc123",
  "taskId": "clxyz123abc"
}
```

| Field              | Type      | Required | Description |
|--------------------|-----------|----------|-------------|
| `agentId`          | `string`  | Yes      | Agent to use |
| `taskId`           | `string`  | Yes      | Task to work on |
| `skipInitialPrompt`| `boolean` | No       | If true, starts session without sending task prompt |

**Response:** `200 OK`

```json
{
  "sessionId": "sess_abc123"
}
```

**Error:** `400` — Agent or task not found, or agent already has an active session for this task.

---

#### `POST /api/sessions/:sessionId/resume`

Resume an existing agent session (reconnect to a previously started session).

**Path Parameters:**

| Param       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | The persisted session ID (stored in `task.session_id`) |

**Request Body:**

```json
{
  "agentId": "agent_abc123",
  "taskId": "clxyz123abc"
}
```

| Field     | Type     | Required | Description |
|-----------|----------|----------|-------------|
| `agentId` | `string` | Yes      | Agent that owns the session |
| `taskId`  | `string` | Yes      | Task associated with the session |

**Response:** `200 OK`

```json
{
  "sessionId": "sess_abc123"
}
```

The resumed session replays its full message history via WebSocket `agent:output` events.

**Error:** `404` — Session not found or expired.

---

#### `POST /api/sessions/:sessionId/send`

Send a new user message to the agent (a new instruction or follow-up).

> **Important:** Do NOT use this endpoint to answer agent questions. Use `/approve` for that. See [Interaction Routing](#interaction-routing) below.

**Path Parameters:**

| Param       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | Active session ID |

**Request Body:**

```json
{
  "message": "Please also add unit tests for the login component",
  "taskId": "clxyz123abc",
  "agentId": "agent_abc123"
}
```

| Field     | Type     | Required | Description |
|-----------|----------|----------|-------------|
| `message` | `string` | Yes      | User message text |
| `taskId`  | `string` | No       | Task ID (used for auto-recovery if session is destroyed) |
| `agentId` | `string` | No       | Agent ID (used for auto-recovery if session is destroyed) |

**Response:** `200 OK`

```json
{
  "success": true,
  "newSessionId": "sess_new456"
}
```

| Field          | Type     | Description |
|----------------|----------|-------------|
| `success`      | `boolean`| Always true on success |
| `newSessionId` | `string?`| Only present if session was re-keyed during auto-recovery |

The agent's response streams via WebSocket `agent:output` events.

---

#### `POST /api/sessions/:sessionId/approve`

Respond to an agent's permission request OR answer an agent's question.

This single endpoint handles **two distinct interaction types**. Set `responseType` for a question so an adapter that supports both interactions uses its question endpoint:

1. **Permission requests** (ACP/Codex adapters) — agent needs approval for a risky action (e.g., running a bash command). These arrive via `agent:status` with `status: "waiting_approval"` and may include a `pendingApproval` object.
2. **Questions** (Claude Code / all adapters) — agent asks the user a structured question with options. These arrive as `agent:output` events with `partType: "question"` and `data.tool.questions` array rendered inline in the transcript.

**Path Parameters:**

| Param       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | Active session ID |

**Request Body:**

```json
{
  "approved": true,
  "message": "JWT",
  "responseType": "question"
}
```

| Field          | Type                         | Required | Description |
|----------------|------------------------------|----------|-------------|
| `approved`     | `boolean`                    | Yes      | `true` to approve/answer, `false` to reject |
| `message`      | `string`                     | No       | The answer text (for questions) or optional context (for permissions) |
| `responseType` | `"permission" \| "question"` | No       | Use `"question"` when the user answers a structured question |

**For single-question answers**, pass the selected option label directly:

```json
{ "approved": true, "message": "JWT", "responseType": "question" }
```

**For multi-question answers**, format as `"Header: Answer"` pairs separated by newlines:

```json
{ "approved": true, "message": "Auth Method: JWT\nToken Storage: HttpOnly Cookie", "responseType": "question" }
```

**For permission rejections:**

```json
{ "approved": false }
```

**Response:** `200 OK`

```json
{ "success": true }
```

---

#### Interaction Routing

The mobile client must implement the same smart routing as the desktop UI. When the user submits text from the chat input:

```
1. Look at the LAST message in the transcript
2. IF lastMessage.partType === "question" AND lastMessage.tool?.questions exists:
     → Call POST /api/sessions/:id/approve  { approved: true, message: answerText }
3. ELSE:
     → Call POST /api/sessions/:id/send     { message: text }
```

This is how the three user interactions map to API calls:

| User Action | Trigger | API Endpoint |
|-------------|---------|--------------|
| Type a new message in chat | Text input, no pending question | `POST /send` |
| Select an answer to agent question | Question options in transcript | `POST /approve` with `approved: true` |
| Approve a risky action | Permission banner | `POST /approve` with `approved: true` |
| Reject a risky action | Permission banner | `POST /approve` with `approved: false` |

---

#### `POST /api/sessions/:sessionId/sync`

Replay messages from a running session. Used to re-sync the client transcript after a reconnect.

**Path Parameters:**

| Param       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | Active session ID |

**Response:** `200 OK`

```json
{
  "success": true,
  "status": "working"
}
```

| Field     | Type            | Description |
|-----------|-----------------|-------------|
| `success` | `boolean`       | Always true on success |
| `status`  | `SessionStatus` | Current session status |

The server replays the full message history via WebSocket `agent:output` events.

**Error:** `404` — Session not found or not running.

---

#### `POST /api/sessions/:sessionId/abort`

Interrupt the current generation. Stops polling, preserves transcript. The session stays alive and can receive new messages.

**Path Parameters:**

| Param       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | Active session ID |

**Response:** `200 OK`

```json
{ "success": true }
```

---

#### `POST /api/sessions/:sessionId/stop`

Fully destroy a session. Removes from memory, resets task status to `not_started` (unless task is already `completed`).

**Path Parameters:**

| Param       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | Active session ID |

**Response:** `200 OK`

```json
{ "success": true }
```

---

## WebSocket API

### Connection

```
ws://<host>:20620/ws?token=<auth_token>
```

After connection, the server streams all real-time events as JSON messages. The client does not send messages over WebSocket (all actions go through REST API).

Each WebSocket message is a JSON object with a `type` field indicating the event type:

```json
{
  "type": "agent:output",
  "payload": { ... }
}
```

---

### Events: Server → Client

#### `agent:output`

An agent transcript message or streaming update.

```json
{
  "type": "agent:output",
  "payload": {
    "sessionId": "sess_abc123",
    "taskId": "clxyz123abc",
    "type": "message",
    "data": {
      "id": "msg_unique_id",
      "role": "assistant",
      "content": "I'll start by creating the login component...",
      "partType": "text",
      "update": false,
      "tool": null
    }
  }
}
```

**`payload` fields:**

| Field       | Type     | Description |
|-------------|----------|-------------|
| `sessionId` | `string` | Session that produced this message |
| `taskId`    | `string` | Associated task |
| `type`      | `string` | Always `"message"` |
| `data`      | `object` | Message content (see below) |

**`data` fields:**

| Field      | Type      | Description |
|------------|-----------|-------------|
| `id`       | `string`  | Unique message/part ID (for deduplication) |
| `role`     | `string`  | `user`, `assistant`, or `system` |
| `content`  | `string`  | Text content (may be markdown) |
| `partType` | `string?` | Message category (see [PartType enum](#parttype)) |
| `update`   | `boolean?`| If `true`, this replaces an existing message with the same `id` (streaming) |
| `tool`     | `object?` | Tool call data (see [ToolData](#tooldata)) |
| `stepTokens`| `object?`| Token usage for `step-finish` events: `{ input, output, cache }` |

---

#### `agent:status`

Agent session status changed.

```json
{
  "type": "agent:status",
  "payload": {
    "sessionId": "sess_abc123",
    "agentId": "agent_abc123",
    "taskId": "clxyz123abc",
    "status": "working"
  }
}
```

**`payload` fields:**

| Field       | Type            | Description |
|-------------|-----------------|-------------|
| `sessionId` | `string`        | Session ID |
| `agentId`   | `string`        | Agent ID |
| `taskId`    | `string`        | Task ID |
| `status`    | `SessionStatus` | `idle`, `working`, `error`, `waiting_approval` |

---

#### `task:updated`

A task's fields were updated (by agent workflow, external sync, or MCP tool).

```json
{
  "type": "task:updated",
  "payload": {
    "taskId": "clxyz123abc",
    "updates": {
      "status": "ready_for_review",
      "output_fields": [...]
    }
  }
}
```

**`payload` fields:**

| Field     | Type                   | Description |
|-----------|------------------------|-------------|
| `taskId`  | `string`               | Updated task ID |
| `updates` | `Partial<Task>`        | Changed fields (may be full task object or partial) |

---

#### `task:created`

A new task was created (by agent via MCP tool, or by external sync).

```json
{
  "type": "task:created",
  "payload": {
    "task": { ... }
  }
}
```

**`payload` fields:**

| Field  | Type   | Description |
|--------|--------|-------------|
| `task` | `Task` | Full task object |

---

#### `agent:incompatible-session`

A session was found to be expired or incompatible on the server side.

```json
{
  "type": "agent:incompatible-session",
  "payload": {
    "taskId": "clxyz123abc",
    "agentId": "agent_abc123",
    "error": "This session no longer exists on the server."
  }
}
```

**`payload` fields:**

| Field     | Type     | Description |
|-----------|----------|-------------|
| `taskId`  | `string` | Affected task |
| `agentId` | `string` | Affected agent |
| `error`   | `string` | Human-readable error message |

---

#### `harness-maintenance:updated`

One or more harnesses' status changed — after a passive check, a manual "Check now", or an update finishing. Desktop and mobile both receive this.

```json
{
  "type": "harness-maintenance:updated",
  "payload": [{ "...": "HarnessMaintenanceStatus, see GET /api/harness-maintenance" }]
}
```

`payload` is always an array, even for a single harness.

---

#### `harness-maintenance:progress`

Live output while an update runs.

```json
{
  "type": "harness-maintenance:progress",
  "payload": { "harness": "codex", "chunk": "Running codex update\n" }
}
```

---

## Type Definitions

### TaskStatus

```
not_started       — Task created, no agent assigned or not yet started
triaging          — Triage agent is evaluating the task
agent_working     — Agent is actively executing
ready_for_review  — Agent finished, awaiting human review
agent_learning    — Agent is learning from feedback
completed         — Task is done
```

### TaskType

```
coding     — Code writing/modification task
manual     — Human-only task
review     — Code review task
approval   — Approval gate task
general    — General task (default)
```

### TaskPriority

```
critical   — Highest priority
high       — High priority
medium     — Normal priority (default)
low        — Low priority
```

### SessionStatus

```
idle              — Session exists but not actively generating
working           — Agent is generating a response
error             — Session encountered an error (can retry with send)
waiting_approval  — Agent is waiting for user approval/answer
```

### PartType

Message `partType` field values:

```
text          — Plain text / markdown content
tool          — Tool invocation (file edit, bash, etc.)
question      — Agent asking user a question (interactive)
todowrite     — Agent managing its internal task list
step-start    — Beginning of a processing step (absorbed by client for timing)
step-finish   — End of a processing step (carries token usage)
error         — Error message
```

### ToolData

When `partType` is `"tool"`, the `tool` object contains:

```json
{
  "name": "Edit",
  "status": "succeeded",
  "title": "Edit src/components/Login.tsx",
  "input": "{ \"file\": \"src/components/Login.tsx\", ... }",
  "output": "File edited successfully",
  "error": null,
  "questions": null,
  "todos": null
}
```

| Field       | Type      | Description |
|-------------|-----------|-------------|
| `name`      | `string`  | Tool name (e.g., `Edit`, `Bash`, `Read`, `Grep`) |
| `status`    | `string`  | `pending`, `running`, `succeeded`, `failed` |
| `title`     | `string?` | Human-readable summary of the tool call |
| `input`     | `string?` | Tool input (usually JSON string) |
| `output`    | `string?` | Tool output text |
| `error`     | `string?` | Error message if tool failed |
| `questions` | `array?`  | Interactive questions (see below) |
| `todos`     | `array?`  | Todo list items (see below) |

**Question format** (when `partType` is `"question"`):

```json
{
  "questions": [
    {
      "header": "Authentication Method",
      "question": "Which authentication method should we use?",
      "options": [
        { "label": "JWT", "description": "JSON Web Tokens" },
        { "label": "OAuth", "description": "OAuth 2.0 flow" }
      ]
    }
  ]
}
```

**Todo format** (when `partType` is `"todowrite"`):

```json
{
  "todos": [
    { "id": "todo_1", "content": "Create login form", "status": "completed" },
    { "id": "todo_2", "content": "Add validation", "status": "in_progress" },
    { "id": "todo_3", "content": "Write tests", "status": "pending" }
  ]
}
```

### Task (Full Object)

```typescript
interface Task {
  id: string
  title: string
  description: string                              // Markdown
  type: TaskType
  priority: TaskPriority
  status: TaskStatus
  assignee: string
  due_date: string | null                          // ISO 8601
  labels: string[]
  attachments: FileAttachment[]
  repos: string[]                                  // "owner/repo" format
  output_fields: OutputField[]
  agent_id: string | null
  session_id: string | null                        // Persisted session ID for resume
  external_id: string | null                       // External integration ID
  source_id: string | null                         // Task source ID
  source: string                                   // "local", "linear", "hubspot", etc.
  skill_ids: string[] | null                       // null = use agent defaults
  snoozed_until: string | null                     // ISO 8601; "9999-12-31..." = Someday
  resolution: string | null
  feedback_rating: number | null                   // 1-5
  feedback_comment: string | null
  is_recurring: boolean
  recurrence_pattern: RecurrencePattern | null      // Cron string or object
  recurrence_parent_id: string | null
  last_occurrence_at: string | null
  next_occurrence_at: string | null
  created_at: string                               // ISO 8601
  updated_at: string                               // ISO 8601
}
```

### FileAttachment

```typescript
interface FileAttachment {
  id: string
  filename: string
  size: number                                     // Bytes
  mime_type: string
  added_at: string                                 // ISO 8601
}
```

### OutputField

```typescript
interface OutputField {
  id: string
  name: string
  type: OutputFieldType                            // text, number, email, textarea, list, date, file, boolean, country, currency, url
  multiple?: boolean
  options?: string[]
  required?: boolean
  value?: unknown
}
```

### Agent

```typescript
interface Agent {
  id: string
  name: string
  server_url: string                               // Default: "http://localhost:4096"
  config: AgentConfig
  is_default: boolean
  created_at: string
  updated_at: string
}

interface AgentConfig {
  coding_agent?: "opencode" | "claude-code" | "codex" | "cursor" | "pi"
  model?: string
  system_prompt?: string
  mcp_servers?: Array<string | AgentMcpServerEntry>
  skill_ids?: string[]
  secret_ids?: string[]
  max_parallel_sessions?: number                   // 1-10, default 1
  api_keys?: {
    openai?: string
    anthropic?: string
  }
}

interface AgentMcpServerEntry {
  serverId: string
  enabledTools?: string[]
}
```

### RecurrencePattern

Either a cron expression string or a structured object:

```typescript
type RecurrencePattern = string | RecurrencePatternObject

interface RecurrencePatternObject {
  type: "daily" | "weekly" | "monthly" | "custom"
  interval: number
  time: string                                     // "HH:MM"
  weekdays?: number[]                              // 0=Sun, 6=Sat
  monthDay?: number                                // 1-31
  endDate?: string                                 // ISO 8601
  maxOccurrences?: number
}
```

---

## Message Deduplication Protocol

Clients MUST implement message deduplication using the `data.id` field:

1. Track seen message IDs per task session.
2. If `data.update === true` and `id` is already seen → **replace** the existing message content.
3. If `data.update === false` (or absent) and `id` is already seen → **ignore** (duplicate).
4. `step-start` events: Record timestamp, do not render as a message.
5. `step-finish` events: Compute duration from last `step-start`, annotate last assistant message with `{ durationMs, tokens }`.
6. When a session is resumed, the server replays the full message history. The client should clear its dedup set and message array before processing replayed messages.

---

## Error Handling

| HTTP Status | Meaning |
|-------------|---------|
| `200`       | Success |
| `400`       | Bad request (missing required fields, invalid params) |
| `401`       | Unauthorized (missing or invalid auth token) |
| `404`       | Resource not found (task, agent, session) |
| `500`       | Internal server error |

All error responses include:
```json
{ "error": "Descriptive error message" }
```
