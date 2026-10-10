# Windows Development Setup

This guide covers building and running 20x from source on Windows. It complements the general instructions in [CONTRIBUTING.md](../CONTRIBUTING.md).

For Windows-specific runtime behavior (MCP spawning, agent adapters, installer config), see [WINDOWS_PORT_LOG.md](../WINDOWS_PORT_LOG.md).

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | >= 22 | [nodejs.org](https://nodejs.org/) or installed via the in-app Setup Wizard |
| **pnpm** | >= 9 | Required — this project does not use npm for day-to-day development |
| **Git** | Latest | Required for worktree features |
| **Visual Studio 2022 Build Tools** | Latest | Required to compile native modules (`better-sqlite3`, `node-pty`) for Electron |

Optional:

- **GitHub CLI** (`gh`) — for repo and PR workflows
- **GitLab CLI** — for GitLab repo features

## 1. Install pnpm

If pnpm is not on your PATH:

```powershell
npm install -g pnpm@9
pnpm --version
```

## 2. Install Visual Studio Build Tools (before `pnpm install`)

Native addons must be compiled against Electron's Node.js runtime, not your system Node.js. This requires MSVC build tools. **Install this before running `pnpm install`** to avoid a failed postinstall step.

1. Download [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. In the installer, select **Desktop development with C++**
3. Ensure these are included:
   - **MSVC v143** (or latest) C++ x64/x86 build tools
   - **Windows SDK**

### Optional: embedded terminal support (`node-pty`)

If `node-pty` fails to rebuild with **MSB8040: Spectre-mitigated libraries are required**, the rest of the app still runs — only canvas terminal panels are affected.

To fix it, open **Visual Studio Installer → Modify → Individual components** and add:

- **MSVC Spectre-mitigated libs (x64/x86)**

Then rerun the rebuild command from step 3.

## 3. Clone and install dependencies

```powershell
git clone https://github.com/YOUR-USERNAME/20x.git
cd 20x
git remote add upstream https://github.com/peakflo/20x.git
pnpm install
```

If you are not contributing, you can clone `https://github.com/peakflo/20x.git` directly and skip the `upstream` remote.

`pnpm install` runs a postinstall script that rebuilds native modules for Electron. If postinstall fails (exit code 1), dependencies are still installed — complete step 2 and rerun:

```powershell
node scripts/rebuild-native.mjs
```

### What gets rebuilt

| Module | Required? | Purpose |
|--------|-----------|---------|
| `better-sqlite3` | **Yes** | Local SQLite database — app will not start without this |
| `node-pty` | No | Embedded terminals in the canvas workspace |

The rebuild script continues if `node-pty` fails and logs a warning.

## 4. Run the app

```powershell
pnpm dev
```

This starts `electron-vite dev`, builds main/preload/renderer, and opens the 20x window.

On first launch you may see:

- An **onboarding wizard** (agent setup, optional CLI tool detection/install, templates)
- An **Electron Security Warning** about Content-Security-Policy — expected in dev; it does not appear in packaged builds
- **Database migrations** in the terminal — normal on first run or after pulling schema changes

### Verify startup

Successful startup logs include lines like:

```
[TaskApiServer] Started on port ...
[SecretBroker] Started on port ...
[MobileAPI] Started on port ...
```

## 5. Run tests

`package.json` test scripts use Unix env-var syntax (`ELECTRON_RUN_AS_NODE=1 electron ...`), which **does not work in PowerShell or cmd** — setting `$env:ELECTRON_RUN_AS_NODE` first does not help because pnpm still invokes the Unix-form script string.

### PowerShell (recommended)

Set the env var, then invoke vitest through Electron directly:

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
pnpm exec electron ./node_modules/vitest/vitest.mjs run
```

Individual projects:

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
pnpm exec electron ./node_modules/vitest/vitest.mjs run --project main
pnpm exec electron ./node_modules/vitest/vitest.mjs run --project renderer
```

### Git Bash

Git Bash can run the npm scripts as written:

```bash
pnpm test:run
pnpm test:main
pnpm test:renderer
```

Before opening a PR, run the full CI-equivalent checks:

```powershell
pnpm lint
pnpm typecheck
pnpm build
$env:ELECTRON_RUN_AS_NODE = "1"
pnpm exec electron ./node_modules/vitest/vitest.mjs run
```

## 6. Build the Windows installer

```powershell
pnpm build:win
```

Output: `dist/20x Setup {version}.exe`

The NSIS installer requires administrator elevation (`requestedExecutionLevel: requireAdministrator` in `package.json`).

## Local data paths

| Data | Path |
|------|------|
| SQLite database | `%APPDATA%\20x\pf-desktop.db` |
| Crash logs | `%APPDATA%\20x\logs\crash.log` |
| Secret shell wrapper | `%APPDATA%\20x\secret-shell.ps1` |
| Task workspaces | `%APPDATA%\20x\workspaces\{taskId}\` |
| Task attachments | `%APPDATA%\20x\attachments\{taskId}\` |

The database file is named `pf-desktop.db` (legacy name) inside the `20x` app data folder.

On uninstall, the NSIS installer **asks** whether to remove app data. Choosing **No** keeps your database and settings. App upgrades preserve data automatically.

## Troubleshooting

### `pnpm` is not recognized

Install globally with `npm install -g pnpm@9`, then reopen your terminal.

### `node-gyp` / Visual Studio not found

Install **Visual Studio 2022 Build Tools** with the **Desktop development with C++** workload, then run:

```powershell
node scripts/rebuild-native.mjs
```

### App crashes on startup with a `better-sqlite3` error

The native module was built for system Node.js instead of Electron. Rerun `node scripts/rebuild-native.mjs`.

### `pnpm dev` builds but the window closes immediately

Check `%APPDATA%\20x\logs\crash.log` for the stack trace. Common causes: missing native rebuild or a stale database from an older install — try renaming `%APPDATA%\20x` temporarily to start fresh.

### Agent CLI tools not found

Use **Settings → General → Agent & Tool Setup → Open Setup Wizard** to detect and install Git, OpenCode, Claude Code, or Codex. On Windows, npm-based tools install as `.cmd` wrappers — the app handles this automatically.

## Contributing from Windows

1. Fork the repo on GitHub
2. Add remotes: `origin` (your fork), `upstream` (peakflo/20x)
3. Sync before each branch:

```powershell
git fetch upstream
git merge upstream/main
```
4. Push to your fork and open a PR against `peakflo/20x:main`

See [CONTRIBUTING.md](../CONTRIBUTING.md) for commit conventions and the PR checklist.
