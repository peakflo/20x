# OpenCode Endpoint Verification

Comparing all endpoints used in `agent-manager.ts` against OpenCode's OpenAPI specification.

## Direct Fetch Calls

### ✅ Health Check
```typescript
// Line 198
const response = await fetch(`${testUrl}/global/health`)
```
**OpenAPI Endpoint:** `GET /global/health`
**Status:** ✅ CORRECT (just fixed)
**Returns:** `{ "healthy": true, "version": "1.1.50" }`

### ✅ Remote MCP Server Testing
```typescript
// Lines 1355, 1378, 1384
await fetch(serverData.url, { ... })
```
**Purpose:** Testing remote MCP servers (not OpenCode endpoints)
**Status:** ✅ CORRECT - These are external MCP server URLs, not OpenCode endpoints

## SDK Client Method Calls

All other operations use the SDK client, which abstracts the OpenAPI endpoints.

### Session Operations

| Our Code | SDK Method | OpenAPI Endpoint | Status |
|----------|------------|------------------|--------|
| `ocClient.session.create()` | ✅ | `POST /session` | ✅ Correct |
| `ocClient.session.get()` | ✅ | `GET /session/{sessionID}` | ✅ Correct |
| `session.ocClient.session.messages()` | ✅ | `GET /session/{sessionID}/message` | ✅ Correct |
| `session.ocClient.session.status()` | ✅ | `GET /session/status` | ✅ Correct |
| `session.ocClient.session.prompt()` | ✅ | `POST /session/{sessionID}/prompt_async` | ✅ Correct |
| `session.ocClient.session.abort()` | ✅ | `POST /session/{sessionID}/abort` | ✅ Correct |

**Note:** The SDK uses `prompt()` method name which maps to `/prompt_async` endpoint. This is correct - the SDK abstracts endpoint naming.

### MCP Operations

| Our Code | SDK Method | OpenAPI Endpoint | Status |
|----------|------------|------------------|--------|
| `ocClient.mcp.add()` | ✅ | `POST /mcp` | ✅ Correct |
| `ocClient.mcp.connect()` | ✅ | `POST /mcp/{name}/connect` | ✅ Correct |

### Configuration Operations

| Our Code | SDK Method | OpenAPI Endpoint | Status |
|----------|------------|------------------|--------|
| `ocClient.config.providers()` | ✅ | `GET /config/providers` | ✅ Correct |

## Available but Unused Endpoints

These OpenCode endpoints exist but we're not using them yet:

### Session Operations (Potential Features)
- `POST /session/{sessionID}/command` - Execute slash commands
- `POST /session/{sessionID}/shell` - Run shell commands
- `POST /session/{sessionID}/fork` - Fork a session
- `POST /session/{sessionID}/share` - Share session
- `GET /session/{sessionID}/children` - Get child sessions
- `POST /session/{sessionID}/summarize` - Summarize session
- `POST /session/{sessionID}/todo` - Manage todos
- `GET /session/{sessionID}/diff` - Get diff
- `POST /session/{sessionID}/revert` - Revert changes

### File Operations (Could Enhance Features)
- `POST /find` - Search text in files
- `POST /find/file` - Find files by pattern
- `POST /find/symbol` - Find code symbols
- `GET /file/content` - Read file content
- `GET /file/status` - Git status for files

### Event Streaming (Performance Improvement)
- `GET /event` - Subscribe to server-sent events (better than polling!)

### MCP Authentication
- `POST /mcp/{name}/auth` - Authenticate with MCP server
- `POST /mcp/{name}/auth/callback` - OAuth callback
- `POST /mcp/{name}/disconnect` - Disconnect MCP server

### Global Config
- `GET /global/config` - Get global configuration
- `GET /config` - Get current config

### Experimental Features
- `GET /experimental/tool` - List available tools
- `GET /experimental/tool/ids` - Get tool IDs
- `POST /experimental/resource` - Access resources
- `GET /experimental/worktree` - Worktree operations
- `POST /experimental/worktree/reset` - Reset worktree

## Summary

✅ **All endpoints we're using are CORRECT**

The only issue was the health check endpoint which has been fixed:
- ❌ Was using: `/health`
- ✅ Now using: `/global/health`

All SDK method calls correctly map to their corresponding OpenAPI endpoints. The SDK properly abstracts the OpenAPI specification.

## Recommendations

1. ✅ **No breaking issues** - All current endpoint usage is correct
2. ⚠️ **Consider adding:** Event streaming (`/event`) instead of polling
3. ⚠️ **Consider adding:** File search APIs for better file operations
4. ⚠️ **Consider adding:** Shell commands (`/session/{sessionID}/shell`) if needed
5. ⚠️ **Consider adding:** Session sharing/forking for collaboration features
