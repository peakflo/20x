# OpenCode SDK Implementation (Composio Approach)

## What Changed

### 1. Replaced Binary Spawning with SDK Embedded Server

**Before:**
```typescript
// Spawned external opencode binary
this.serverProcess = spawn('opencode', ['serve'])
```

**After:**
```typescript
// Use SDK to create embedded server
const { server } = await OpenCodeSDK.createOpencode({
  hostname: '127.0.0.1',
  port: 4096
})
```

### 2. Benefits

✅ **No PATH issues** - Works from Applications folder (no shell PATH needed)
✅ **Zero external dependencies** - OpenCode bundled as npm package
✅ **Simpler setup** - No user installation required
✅ **Programmatic control** - Start/stop server in code
✅ **Same features** - Full OpenCode functionality via SDK

### 3. Files Modified

1. **src/main/agent-manager.ts**
   - Removed `spawn()` for OpenCode server
   - Added `createOpencode()` SDK call
   - Server is now an embedded instance, not external process

2. **src/main/ipc-handlers.ts**
   - Updated `deps:check` to verify SDK is installed (not binary)
   - Removed opencode binary PATH checking

3. **src/renderer/src/components/layout/DepsWarningBanner.tsx**
   - Removed OpenCode installation step from onboarding
   - OpenCode now works out of the box!

### 4. How It Works

```
┌─────────────────────────────────────┐
│   Electron App (Main Process)      │
│                                     │
│  ┌───────────────────────────────┐ │
│  │ AgentManager                  │ │
│  │                               │ │
│  │  startServer()                │ │
│  │    ↓                          │ │
│  │  createOpencode()             │ │
│  │    ↓                          │ │
│  │  ┌─────────────────────────┐ │ │
│  │  │ OpenCode SDK Server     │ │ │
│  │  │ (Embedded, Port 4096)   │ │ │
│  │  │                         │ │ │
│  │  │ - Handles agent sessions │ │ │
│  │  │ - Manages MCP servers   │ │ │
│  │  │ - Executes tools        │ │ │
│  │  └─────────────────────────┘ │ │
│  │                               │ │
│  │  createOpencodeClient()       │ │
│  │    ↓                          │ │
│  │  [HTTP Client]                │ │
│  └───────────────────────────────┘ │
└─────────────────────────────────────┘
```

### 5. Testing

To verify the implementation:

1. **Start the app:**
   ```bash
   pnpm dev
   ```

2. **Check onboarding:**
   - Should only show GitHub CLI installation
   - OpenCode step is gone ✅

3. **Create an agent:**
   - Should work without any opencode CLI installation
   - Server starts automatically when needed

4. **Start a session:**
   - Agent manager creates embedded server
   - No external process spawned
   - Everything runs in-process

### 6. Remaining Work

For a complete Composio-style implementation, consider:

- [ ] Provider setup flow (configure API keys for models)
- [ ] MCP configuration UI
- [ ] Model selection from available providers

## Comparison

| Feature | Old (Binary Spawn) | New (SDK Embedded) |
|---------|-------------------|-------------------|
| Installation | User installs CLI | npm package (bundled) |
| PATH issues | ❌ Breaks from Apps folder | ✅ Always works |
| Server control | External process | Programmatic |
| Updates | User manages | npm dependency |
| Size | ~0 (external) | ~10MB (bundled) |
| Reliability | ⚠️ PATH-dependent | ✅ Always available |

## Credits

Approach inspired by [ComposioHQ/open-claude-cowork](https://github.com/ComposioHQ/open-claude-cowork)
