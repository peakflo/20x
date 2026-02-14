# macOS Localhost DNS Resolution Issue

## Problem

When launching the app from **Applications/Finder** (UI launch), `localhost` does not resolve to `127.0.0.1` properly, causing server detection to fail.

**Symptoms:**
- ✅ Terminal launch: Detects OpenCode CLI on `localhost:4096`
- ❌ UI launch: Cannot detect OpenCode CLI on `localhost:4096`

## Root Cause

macOS GUI applications don't inherit the same network configuration as terminal applications:

1. **Terminal apps**: Full shell environment, standard DNS resolution
2. **GUI apps**: Sandboxed environment, limited DNS resolution
3. **Result**: `localhost` may not resolve to `127.0.0.1` when app is launched from Finder

This is a known macOS issue affecting Electron and other GUI apps.

## Our Solution

Try **both** `localhost` and `127.0.0.1` variants when detecting servers:

```typescript
private async findAccessibleServer(url: string): Promise<string | null> {
  const urls = [url]

  // Add variant to handle macOS DNS resolution issues
  if (url.includes('localhost')) {
    urls.push(url.replace('localhost', '127.0.0.1'))
  } else if (url.includes('127.0.0.1')) {
    urls.push(url.replace('127.0.0.1', 'localhost'))
  }

  // Try each URL, return the first one that works
  for (const testUrl of urls) {
    try {
      const response = await fetch(`${testUrl}/health`, {
        signal: AbortSignal.timeout(2000)
      })
      if (response.ok || response.status === 404) {
        return testUrl  // This one works!
      }
    } catch {
      continue  // Try next variant
    }
  }

  return null  // None worked
}
```

## Example Flow

**User's OpenCode CLI:**
```bash
$ opencode serve --port=4096
# Server running at http://localhost:4096
```

**Agent config:**
```typescript
{
  server_url: 'http://localhost:4096'
}
```

**UI Launch Detection:**
```
1. Try http://localhost:4096
   → Fails (macOS DNS issue)

2. Try http://127.0.0.1:4096
   → Success! ✅

3. Use http://127.0.0.1:4096 for this session
```

## Why This Works

- **OpenCode CLI** listens on all interfaces (0.0.0.0)
- Both `localhost` and `127.0.0.1` point to the same server
- We just need to find which hostname works in the current context
- The first successful connection determines which URL we use

## Alternative Solutions Considered

### ❌ Always use 127.0.0.1
- Problem: Users might configure `localhost` explicitly
- Problem: Doesn't respect user's intent

### ❌ Add network entitlements
- Problem: Requires code signing changes
- Problem: Might not fully solve the issue

### ✅ Try both variants (chosen)
- Simple, no configuration needed
- Works in all environments
- Respects user configuration while being pragmatic

## Related Issues

This affects any Electron app on macOS that needs to:
- Connect to localhost servers
- Detect local development servers
- Access local APIs

## Testing

### Test Terminal Launch
```bash
$ pnpm dev
# Should detect server at localhost:4096
```

### Test UI Launch
```bash
# Build and launch from Applications
$ pnpm build
$ open /Applications/Workflo\ Workspace.app

# Should detect server at 127.0.0.1:4096 (fallback)
# Logs will show: "Server accessible at http://127.0.0.1:4096"
```

### Test Custom Port
```bash
# Start OpenCode on custom port
$ opencode serve --port=8080

# Update agent config
server_url: 'http://localhost:8080'

# Launch app - should detect at 127.0.0.1:8080
```

## Debug Logs

When troubleshooting, look for:

```
[AgentManager] Checking for server at http://localhost:4096
[AgentManager] Checking server at http://localhost:4096
[AgentManager] Server not accessible at http://localhost:4096: ...
[AgentManager] Checking server at http://127.0.0.1:4096
[AgentManager] Server accessible at http://127.0.0.1:4096
[AgentManager] Found existing server at http://127.0.0.1:4096
```

## References

- [Electron localhost issues on macOS](https://github.com/electron/electron/issues/26788)
- [Node.js net module localhost resolution](https://github.com/nodejs/node/issues/40702)
- Similar issues in other frameworks (Docker Desktop, VS Code)
