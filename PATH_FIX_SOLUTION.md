# PATH Fix for macOS GUI Apps

## The Problem

When launching Electron apps from **Applications/Finder** on macOS, they don't inherit the shell's `PATH` environment variable. This causes:

```
Error: spawn opencode ENOENT
```

Because:
- Terminal apps inherit full shell environment (`.zshrc`, `.bashrc`)
- GUI apps get minimal system PATH only
- CLI tools installed via Homebrew, npm, etc. are not found

## The Solution: `fix-path`

The [`fix-path`](https://github.com/sindresorhus/fix-path) package solves this by reading the user's actual PATH from their shell and setting it in the Electron process.

### Installation

```bash
pnpm add fix-path
```

### Implementation

**In `src/main/index.ts` (MUST be first import):**

```typescript
// Fix PATH for macOS GUI apps - must be first import
import fixPath from 'fix-path'
fixPath()

import { app, BrowserWindow, shell } from 'electron'
// ... rest of imports
```

**IMPORTANT:** Must be the **very first import** and called immediately. This ensures PATH is fixed before any other code runs.

## How It Works

1. **Detects user's shell** (zsh, bash, fish, etc.)
2. **Reads shell PATH** by executing shell and reading environment
3. **Sets `process.env.PATH`** in Electron's main process
4. **Child processes inherit** the corrected PATH

After this, spawning child processes (like `opencode` CLI) works correctly!

## What It Fixes

| Without fix-path | With fix-path |
|------------------|---------------|
| ❌ Can't find `opencode` | ✅ Finds `opencode` |
| ❌ Can't find `gh` | ✅ Finds `gh` |
| ❌ Can't find Homebrew binaries | ✅ Finds Homebrew binaries |
| ❌ Can't find global npm packages | ✅ Finds npm packages |

## Why This Is Better Than Alternatives

### ❌ Alternative 1: Hardcode paths
```typescript
process.env.PATH = '/usr/local/bin:/opt/homebrew/bin:' + process.env.PATH
```
- Problem: Doesn't cover all user setups
- Problem: Misses custom installations
- Problem: Fragile and incomplete

### ❌ Alternative 2: Manual shell execution
```typescript
const { execSync } = require('child_process')
const shellPath = execSync('echo $PATH', { shell: '/bin/zsh' })
process.env.PATH = shellPath
```
- Problem: Assumes shell location
- Problem: More code to maintain
- Problem: Shell-specific

### ✅ `fix-path` (Chosen Solution)
- ✅ Works with any shell (zsh, bash, fish, etc.)
- ✅ Finds user's actual PATH configuration
- ✅ Maintained by Sindre Sorhus (trusted author)
- ✅ Used by VS Code, Hyper, and other popular Electron apps

## Verification

After adding `fix-path`, test both launch methods:

### 1. Terminal Launch (should still work)
```bash
pnpm dev
```

### 2. Applications Launch (now works!)
```bash
pnpm build
open /Applications/Workflo\ Workspace.app
```

Both should now:
- ✅ Detect OpenCode CLI
- ✅ Load providers from `ocClient.config.providers()`
- ✅ Find other CLI tools (`gh`, etc.)

## Debug: Check PATH

To verify PATH is fixed, add temporary logging:

```typescript
// After fixPath()
console.log('[Main] PATH:', process.env.PATH)
```

Should show full PATH including:
- `/opt/homebrew/bin`
- `/usr/local/bin`
- `~/.local/bin`
- npm global bin directories
- etc.

## When to Use

Use `fix-path` whenever your Electron app needs to:
- Spawn CLI tools (git, opencode, gh, etc.)
- Access Homebrew packages
- Run shell commands that depend on PATH
- Use system utilities installed by user

## References

- [fix-path on GitHub](https://github.com/sindresorhus/fix-path)
- [Electron PATH issue](https://github.com/electron/electron/issues/550)
- [Similar issues in VS Code](https://github.com/microsoft/vscode/pull/1391)
