# OpenCode Server Strategy

## Overview

The app intelligently detects and uses existing OpenCode servers (CLI or custom) while maintaining the ability to run standalone with an embedded server. **Server URLs are configured per-agent** and respect custom installations.

## How It Works

### 1. **API Key Loading (Always Happens First)**

```typescript
// Load from app settings → set in process.env
ANTHROPIC_API_KEY=... // From settings
OPENAI_API_KEY=...    // From settings
GOOGLE_API_KEY=...    // From settings
```

This ensures API keys are available to **both** embedded and external OpenCode servers.

### 2. **Server Detection Strategy**

```
┌─────────────────────────────────────┐
│  Agent needs OpenCode server        │
│  (from agent.server_url config)     │
└──────────────┬──────────────────────┘
               │
               ↓
    ┌──────────────────────┐
    │ Load API keys from   │
    │ settings → process.env│
    └──────────┬───────────┘
               │
               ↓
    ┌─────────────────────────────┐
    │ Check if server accessible  │
    │ at agent.server_url         │
    └──────────┬────────────────────┘
               │
        ┌──────┴──────┐
        │             │
    ACCESSIBLE    NOT ACCESSIBLE
        │             │
        ↓             ↓
┌───────────────┐  ┌──────────────────┐
│ Use existing  │  │ Is it default    │
│ server        │  │ URL?             │
└───────────────┘  └────┬─────────────┘
                        │
                  ┌─────┴─────┐
                  │           │
              DEFAULT     CUSTOM
                  │           │
                  ↓           ↓
        ┌──────────────┐  ┌─────────────┐
        │ Create       │  │ Fail with   │
        │ embedded     │  │ clear error │
        │ SDK server   │  │             │
        └──────────────┘  └─────────────┘
```

## Scenarios

### Scenario A: OpenCode CLI on Default Port

**User has:**
```bash
$ which opencode
/opt/homebrew/bin/opencode

$ opencode serve --port=4096
# Server running at http://localhost:4096
```

**Agent config:**
```typescript
{
  server_url: 'http://localhost:4096'  // Default
}
```

**App behavior:**
1. ✅ Checks server at agent's configured URL
2. ✅ Detects existing server
3. ✅ Sets API keys in `process.env` (so CLI server can use them)
4. ✅ Connects to existing server
5. ✅ On shutdown: disconnects (doesn't stop external server)

### Scenario B: No OpenCode CLI

**User has:**
- No OpenCode CLI installed
- OR OpenCode CLI installed but not running

**Agent config:**
```typescript
{
  server_url: 'http://localhost:4096'  // Default
}
```

**App behavior:**
1. ✅ Checks for server (none found)
2. ✅ Recognizes it's the default URL
3. ✅ Creates embedded server via `@opencode-ai/sdk`
4. ✅ Sets API keys in `process.env`
5. ✅ On shutdown: stops embedded server

### Scenario C: Custom OpenCode Server

**User has:**
- Custom OpenCode server running on different port
- OR remote OpenCode server

**Agent config:**
```typescript
{
  server_url: 'http://localhost:8080'  // Custom port
  // or 'https://opencode.mycompany.com'
}
```

**App behavior:**
1. ✅ Checks server at agent's configured URL
2. ✅ If accessible: connects and uses it
3. ❌ If not accessible: fails with clear error (doesn't try to create server on custom URL)
4. ✅ Sets API keys in `process.env` (available for any server)

## Why This Matters

### Problem We're Solving

**Before:**
```
Terminal launch:
  Shell env vars → OpenCode CLI finds keys → ✅ Works

UI launch:
  No env vars → OpenCode CLI can't find keys → ❌ Fails
```

**After:**
```
Terminal OR UI launch:
  App loads keys from settings → process.env
  → OpenCode (CLI or embedded) finds keys → ✅ Works
```

### Benefits

1. **Respects existing installations** - Uses user's OpenCode CLI if available
2. **Works standalone** - Creates embedded server if needed
3. **Consistent API keys** - Both CLI and embedded server use app settings
4. **No port conflicts** - Detects existing server before trying to create new one
5. **Launch method agnostic** - Works from terminal, UI, or anywhere

## Configuration

### Agent Server URLs

Each agent has its own `server_url` configured:

**Default (most users):**
```sql
CREATE TABLE agents (
  ...
  server_url TEXT NOT NULL DEFAULT 'http://localhost:4096',
  ...
);
```

**Custom configurations:**
- Different port: `http://localhost:8080`
- Remote server: `https://opencode.mycompany.com`
- 127.0.0.1 variant: `http://127.0.0.1:4096` (treated as default)

### Where API Keys Are Stored

- **App Settings Database**: `~/Library/Application Support/Workflo Workspace/workflo.db`
- **Settings table**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`

### Onboarding Flow

1. User enters API key in provider setup step
2. Saved to app settings via `settingsApi.set('ANTHROPIC_API_KEY', key)`
3. On startup: loaded from settings → `process.env`
4. OpenCode (CLI, embedded, or custom) picks them up automatically

## Technical Details

### Detection Logic

```typescript
// Called with agent's configured server_url
async startServer(targetUrl: string = DEFAULT_SERVER_URL): Promise<void> {
  // 1. Load API keys from settings
  this.loadApiKeysToEnv()

  // 2. Check if server is accessible
  if (await this.isServerAccessible(targetUrl)) {
    // Server exists! Use it.
    this.serverUrl = targetUrl
    return
  }

  // 3. Server not accessible
  const isDefaultUrl = targetUrl === DEFAULT_SERVER_URL ||
                       targetUrl === 'http://127.0.0.1:4096'

  if (!isDefaultUrl) {
    // Custom URL but not accessible - fail clearly
    throw new Error(`OpenCode server not accessible at ${targetUrl}`)
  }

  // 4. Default URL and not accessible - create embedded server
  const url = new URL(targetUrl)
  const { server } = await OpenCodeSDK.createOpencode({
    hostname: url.hostname,
    port: parseInt(url.port || '4096', 10)
  })
  this.serverInstance = server
  this.serverUrl = targetUrl
}
```

### State Management

```typescript
class AgentManager {
  private serverInstance: any = null  // Embedded server (if we created it)
  private serverUrl: string | null = null  // Server URL (embedded or external)

  // If serverInstance is null but serverUrl is set → using external server
  // If both are set → using embedded server
}
```

## Testing

### Test Case 1: With OpenCode CLI Running

```bash
# Terminal 1
$ opencode serve --port=4096

# Terminal 2
$ pnpm dev
# Should detect existing server and use it
```

### Test Case 2: Without OpenCode CLI

```bash
# Make sure no OpenCode is running
$ pkill -f opencode

# Start app
$ pnpm dev
# Should create embedded server
```

### Test Case 3: UI Launch (Critical!)

```bash
# From Applications folder, double-click app
# Should work regardless of OpenCode CLI presence
# API keys loaded from settings work in both cases
```

## Future Enhancements

- [ ] Allow user to configure preferred port
- [ ] Show in UI whether using CLI or embedded server
- [ ] Health check / reconnection logic
- [ ] Support for remote OpenCode servers
