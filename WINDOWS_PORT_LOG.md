# Windows Port Log

This document records the complete history of porting the 20x Electron desktop app from macOS to Windows, including every change made, every bug found and fixed, and the current state of the project.

## Background

20x is an AI-powered desktop task manager built on Electron. It manages tasks, runs AI coding agents (Claude Code, OpenCode, Codex), connects to MCP servers, and integrates with external services (Linear, HubSpot, Notion, GitHub, Peakflo/Workflo). The app was originally developed and tested exclusively on macOS. This port adds full Windows support.

## What Was Changed

### 1. Main Process Entry Point (`src/main/index.ts`)

**Window configuration:** Added Windows-specific titlebar using `titleBarOverlay` (hidden titlebar with custom symbol colors) instead of macOS's `hiddenInset` traffic lights. The icon path resolves differently in dev vs production: dev uses `../../resources/icon.ico` relative to `__dirname`, production uses `process.resourcesPath`.

**EPIPE error handler:** Added handlers on `process.stdout` and `process.stderr` to catch EPIPE errors. When piping Electron output through `head` or similar commands on Windows, closing the pipe throws an uncaught EPIPE that crashes the app. The handler silently swallows EPIPE and re-throws everything else.

**Renderer crash recovery:** Added `webContents.on('render-process-gone')` handler that auto-reloads the renderer after 1 second if it crashes (reason !== 'clean-exit'). Also added `webContents.on('console-message')` to log renderer warnings and errors to the main process console.

**Process cleanup on quit:** Added `taskkill` command on Windows (vs `pkill` on Unix) to kill orphaned `task-management-mcp` node processes on app exit.

### 2. MCP Task Management Server

This was the most complex issue. The MCP server (`src/main/mcp-servers/task-management-mcp.js`) runs as a separate Node.js process spawned by the app.

**Problem 1 - ASAR packaging:** The MCP server JS file was inside `app.asar`, which can't be spawned as a child process. Fixed by adding `out/main/mcp-servers/**` and `out/main/chunks/**` to `asarUnpack` in `package.json` so these files exist on disk.

**Problem 2 - ELECTRON_RUN_AS_NODE:** On macOS, the app uses `process.execPath` (the Electron binary) with `ELECTRON_RUN_AS_NODE=1` to run the MCP server as plain Node.js. On Windows, this doesn't work properly with the packaged `20x.exe` - it still initializes the full Electron app (crash logger, database, etc.) causing SQLite disk I/O errors. Fixed by using system `node` command on Windows instead (`src/main/database.ts`).

**Problem 3 - TASK_API_URL injection:** The MCP server requires a `TASK_API_URL` environment variable pointing to the internal HTTP API. This was injected by `agent-manager.ts` for agent sessions but NOT by `mcp-tool-caller.ts` for direct tool calls or `testLocalMcpServer`. Fixed by importing `getTaskApiPort()` and injecting `TASK_API_URL` in both `mcp-tool-caller.ts` and `mcp-tool-caller.js`.

**Problem 4 - Single-quote shell joining in testLocalMcpServer:** The `testLocalMcpServer` method in `agent-manager.ts` joined command + args into a shell string using single quotes (`'path'`), then spawned with `shell: true`. On Windows, `cmd.exe` treats single quotes as literal characters, not delimiters. The path became `'C:\...'` which Node.js tried to resolve as part of the filename, producing errors like `Cannot find module 'C:\20x\'C:\20x\...'`. Fixed by spawning directly with args array instead of shell-joining.

### 3. OpenCode Server Spawn (`src/main/agent-manager.ts`, `src/main/adapters/opencode-adapter.ts`)

The `@opencode-ai/sdk` package's `createOpencodeServer()` internally spawns `opencode` without `shell: true`. On Windows, `opencode` is installed as `opencode.cmd` (an npm wrapper), which requires `shell: true` to resolve. Fixed by bypassing the SDK and spawning `opencode.cmd` directly with `shell: true` on Windows in both `agent-manager.ts` and `opencode-adapter.ts`.

### 4. Agent Adapter Spawn Fixes

**`src/main/adapters/acp-adapter.ts`:** Both `createSession()` and `resumeSession()` spawn ACP agent processes without `shell: true`. On Windows, if the command is a `.cmd` wrapper, this fails with ENOENT. Fixed by detecting `.cmd`/`.bat` extensions and adding `shell: true` conditionally.

**`src/main/adapters/codex-adapter.ts`:** Same issue. The `codexExecutablePath` on Windows resolves to `codex.cmd`. Both spawn calls (create and resume) now conditionally add `shell: true`.

**`src/main/adapters/claude-code-adapter.ts`:** Already had Windows-aware binary detection using `where` vs `which`. Spawn calls use the full path to the binary, which works without shell mode.

### 5. Secret Broker Windows Support (`src/main/secret-broker.ts`)

The secret broker generates a shell wrapper script that agent processes use to fetch secrets from a local HTTP broker. The original implementation only generated a bash script (`secret-shell.sh`) with Unix-specific features (`#!/bin/bash`, `curl`, `/tmp/`, `chmod`). Added a Windows PowerShell equivalent (`secret-shell.ps1`) that uses `Invoke-WebRequest` instead of `curl` and handles environment variable injection via `[Environment]::SetEnvironmentVariable()`.

### 6. UI Fixes

**White-on-white dropdown:** Native `<select>` elements with `bg-transparent` showed white text on white dropdown popup on Windows dark themes. Fixed by adding explicit `background-color` and `color` CSS to both `select` and `select option` elements in `globals.css`, using CSS custom properties (`--color-card`, `--color-foreground`).

### 7. Agent Setup Wizard (`src/renderer/src/components/AgentSetupWizard.tsx`)

Built a new non-blocking Radix Dialog component that detects installed CLI tools (Node.js, npm, Git, GitHub CLI, OpenCode, Codex, Claude Code) and lets users install missing ones directly from the app. The wizard:

- Auto-opens on first install or after app updates (version-based flag via `settingsApi`)
- Is accessible anytime from Settings > General > "Open Setup Wizard"
- Streams installation progress to an embedded terminal
- Supports one-click install of Node.js (MSI), Git (EXE), and npm-based tools

The agent installer backend (`src/main/agent-installer/detect.js` and `install.js`) handles Windows-specific installation: MSI installers via PowerShell `Start-Process`, `winget` for GitHub CLI, and `npm.cmd` for npm-based tools.

### 8. Auto-Updater (`src/main/auto-updater.ts`)

Added `electron-updater` integration that checks GitHub Releases for updates on app startup (after 10s delay). Supports:
- Manual check via Settings
- Download with progress tracking
- Quit-and-install flow
- IPC handlers: `updater:check`, `updater:download`, `updater:install`

### 9. Crash Logger (`src/main/crash-logger.ts`)

Added crash logging that captures:
- Session start info (version, platform, Electron/Node versions)
- Renderer process crashes with reason and exit code
- Child process crashes (GPU, Network Service, Utility)
- Uncaught exceptions and unhandled rejections with full stack traces
- Optional dialog for critical uncaught errors

Logs are written to `%APPDATA%/20x/logs/crash.log`.

### 10. Windows Installer Configuration (`package.json`)

Added NSIS installer config:
- `oneClick: false` - shows install wizard with directory selection
- `allowElevation: true` - requests admin for system-wide install
- Desktop and Start Menu shortcuts
- Custom `installer.nsh` for registry cleanup
- `extraResources` to copy `icon.ico` to production resources
- `asarUnpack` for `better-sqlite3` native module, MCP servers, and chunk dependencies

### 11. Build and Support Scripts

- `scripts/convert-icon.mjs` - Converts PNG to ICO format for Windows
- `scripts/reset-setup.cjs` - Resets the setup wizard flag in the database
- `scripts/uninstall.bat` - Standalone uninstaller script
- `scripts/after-pack.js` - Post-build cleanup (removes non-target platform binaries)

### 12. IPC and Preload Changes

Added new IPC channels for the agent installer:
- `agent-installer:detect` - Detects installed CLI tools
- `agent-installer:install` - Installs a tool with progress streaming
- `agent-installer:get-install-command` - Returns display command for a tool

Added IPC channels for the auto-updater:
- `updater:check`, `updater:download`, `updater:install`
- `updater:status` event for progress updates

Added settings persistence IPC:
- `settings:get`, `settings:set` - Key-value store in SQLite `settings` table

## Known Issues and Limitations

1. **Secret broker Windows support is untested.** The PowerShell wrapper script was written but not verified end-to-end with actual agent processes that require secret injection.

2. **Hard-coded tool versions.** Node.js (v22.16.0) and Git (v2.49.0) download URLs in `install.js` will become outdated. Should be fetched dynamically from GitHub releases API.

3. **No UAC elevation for MSI installs.** The `runInstaller` function uses `PowerShell Start-Process` without `-Verb RunAs`, so MSI installations requiring admin will fail silently. Users may need to run 20x as administrator for Node.js/Git installs.

4. **taskkill process cleanup is aggressive.** The orphan cleanup on app quit uses `taskkill /F /FI "IMAGENAME eq node.exe"` with a window title filter, which may not match background processes and could theoretically kill unrelated node processes (though the title filter mitigates this).

5. **DialogTitle accessibility warnings.** Some dialog components produce Radix UI console warnings about missing `DialogTitle` for screen readers. These are cosmetic and don't affect functionality.

6. **Database survives uninstall.** The SQLite database in `%APPDATA%/20x/` persists across uninstall/reinstall. This is intentional (preserves user data) but means stale agent IDs from old installs can cause "Agent not found" errors if the database is from a previous version with different agent IDs.

## Files Changed (Complete List)

### New Files
- `src/main/auto-updater.ts` - Auto-update system
- `src/main/crash-logger.ts` - Crash logging
- `src/main/agent-installer/detect.js` - CLI tool detection
- `src/main/agent-installer/install.js` - CLI tool installation
- `src/main/mcp-tool-caller.js` - Standalone MCP tool caller (JS version for agent sessions)
- `src/main/mcp-servers/task-management-mcp.js` - Standalone MCP server (pre-built JS)
- `src/renderer/src/components/AgentSetupWizard.tsx` - Setup wizard UI
- `resources/icon.ico` - Windows app icon
- `resources/installer.nsh` - NSIS installer script
- `scripts/convert-icon.mjs` - Icon converter
- `scripts/reset-setup.cjs` - Setup flag reset
- `scripts/uninstall.bat` - Standalone uninstaller

### Modified Files
- `src/main/index.ts` - Window config, EPIPE handler, crash recovery, process cleanup
- `src/main/agent-manager.ts` - OpenCode spawn fix, testLocalMcpServer fix, TASK_API_URL injection
- `src/main/database.ts` - MCP server uses `node` on Windows, settings table
- `src/main/mcp-tool-caller.ts` - Shell mode detection, TASK_API_URL injection
- `src/main/secret-broker.ts` - Windows PowerShell wrapper
- `src/main/ipc-handlers.ts` - Agent installer and updater IPC handlers
- `src/main/adapters/opencode-adapter.ts` - Custom spawn with shell:true on Windows
- `src/main/adapters/claude-code-adapter.ts` - Windows binary detection
- `src/main/adapters/codex-adapter.ts` - Shell:true for .cmd wrappers
- `src/main/adapters/acp-adapter.ts` - Shell:true for .cmd wrappers
- `src/preload/index.ts` - Agent installer and updater preload APIs
- `src/renderer/src/components/layout/AppLayout.tsx` - Setup wizard integration
- `src/renderer/src/components/settings/tabs/GeneralSettings.tsx` - Setup wizard button
- `src/renderer/src/styles/globals.css` - Dropdown color fix
- `src/renderer/src/lib/ipc-client.ts` - Agent installer and updater client
- `src/renderer/src/types/electron.d.ts` - New type definitions
- `package.json` - Windows build config, new dependencies, asarUnpack, extraResources
- `electron.vite.config.ts` - MCP server as separate entry point
- `tsconfig.node.json` - Build config adjustments

## Current State

**What works:**
- App launches and runs on Windows without errors
- NSIS installer creates proper Windows installation with shortcuts
- Taskbar icon displays correctly
- OpenCode providers load (anthropic + opencode)
- MCP task-management server spawns via system `node` with correct TASK_API_URL
- Agent Setup Wizard detects and installs CLI tools
- Dropdown text is readable on Windows dark theme
- Crash logger captures renderer crashes and auto-recovers
- Auto-updater checks GitHub Releases on startup
- All agent adapters (Claude Code, OpenCode, Codex) handle Windows .cmd wrappers

**What a new developer needs to know:**
- Run `pnpm install` then `pnpm build:win` to create the Windows installer
- The installer output is at `dist/20x Setup {version}.exe`
- For development, use `pnpm run dev` which runs electron-vite dev server
- The app uses two databases: SQLite (`pf-desktop.db` in `%APPDATA%/20x/`) for task/agent data, and in-memory settings
- MCP servers are spawned as separate Node.js processes, not inside the Electron renderer
- The `mcp-tool-caller.js` (standalone JS) and `mcp-tool-caller.ts` (bundled TS) must be kept in sync
- Windows-specific code is always behind `process.platform === 'win32'` checks so Mac behavior is unchanged
- The `after-pack.js` script removes non-target platform binaries from the build output to reduce installer size
