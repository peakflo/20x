# Workflo Workspace

A desktop task management app built with Electron, React, and SQLite. Designed for individual productivity with a focus on local-first data ownership and a clean, dark-themed UI.

## Features

- **Local-first**: All data stored in SQLite on your machine. No accounts, no cloud sync.
- **Full task lifecycle**: Create, edit, delete tasks with status tracking from inbox to completion.
- **Rich task model**: Types (coding, review, approval, manual, general), priorities (critical to low), checklists, labels, assignees, due dates.
- **Filtering & sorting**: Filter by status or priority, sort by any field, full-text search across titles, descriptions, and labels.
- **Dark UI**: Slate-toned dark theme with a native macOS-style title bar.

## Screenshots

> _Coming soon_

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Shell | Electron 34 |
| Build | electron-vite |
| Frontend | React 19 + Tailwind CSS 4 + Zustand 5 |
| Icons | Lucide React |
| Database | SQLite via better-sqlite3 |
| IDs | @paralleldrive/cuid2 |

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **pnpm** >= 9

### Install

```bash
pnpm install
```

### Development

```bash
pnpm run dev
```

Opens the Electron window with hot-reload. The renderer uses Vite HMR; the main process restarts on file changes.

### Build

```bash
pnpm run build
```

Produces the compiled app in `out/`. To package a distributable:

```bash
pnpm run build && npx electron-builder
```

Targets: macOS (dmg, zip), Windows (nsis), Linux (AppImage).

## Project Structure

```
src/
  main/                  Electron main process
    index.ts             App lifecycle, window creation
    database.ts          SQLite operations (better-sqlite3)
    ipc-handlers.ts      IPC handler registrations
  preload/               Context bridge
    index.ts             electronAPI exposure
  renderer/              React app (Vite)
    src/
      types/             TypeScript types and DTOs
      stores/            Zustand stores (task state, UI state)
      hooks/             Custom hooks (filtering, sorting)
      lib/               Utilities (IPC client, cn(), date helpers)
      components/
        ui/              Primitives (Button, Input, Modal, etc.)
        tasks/           Task-specific components
        layout/          App shell (TitleBar, Sidebar, AppLayout)
      styles/            Tailwind CSS entry point
```

## Architecture

### Data Flow

```
React UI  -->  Zustand Store  -->  IPC Client  -->  Preload Bridge  -->  Main Process  -->  SQLite
```

- **Renderer** (React) never touches Node.js APIs directly.
- **Preload** exposes a minimal, typed API surface via `contextBridge`.
- **Main process** owns the database and handles all IPC calls synchronously (better-sqlite3 is synchronous, which is appropriate for the main process).
- **Zustand** stores hold UI state and task data, calling IPC through a typed client wrapper.

### Security Model

- `contextIsolation: true` — renderer cannot access Node.js globals.
- `nodeIntegration: false` — no `require()` in renderer.
- `sandbox: false` — required for better-sqlite3 native module in main process. The renderer is still fully isolated via context isolation.
- All external links open in the system browser (`setWindowOpenHandler`).
- Database writes use parameterized queries exclusively. Dynamic column names in `UPDATE` are validated against a compile-time whitelist.

### Task Data Model

Each task has:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | cuid2 |
| `title` | string | Required |
| `description` | string | Markdown-compatible |
| `type` | enum | `coding`, `manual`, `review`, `approval`, `general` |
| `priority` | enum | `critical`, `high`, `medium`, `low` |
| `status` | enum | `inbox`, `accepted`, `in_progress`, `pending_review`, `completed`, `cancelled` |
| `assignee` | string | Free text |
| `due_date` | string \| null | ISO 8601 |
| `labels` | string[] | Stored as JSON |
| `checklist` | ChecklistItem[] | Stored as JSON |
| `source` | string | `local` for now; future: `notion`, `workflo` |
| `created_at` | string | ISO 8601 |
| `updated_at` | string | ISO 8601 |

The `source` field is included from day one so future task sources (Notion, Peakflo Workflo) won't require schema migration.

## Roadmap

See [AGENTS.md](./AGENTS.md) for the multi-agent architecture planned for Phase 3.

- **Phase 1** (current): Local task CRUD
- **Phase 2**: Keyboard shortcuts, light/dark theme toggle, due date tracking, notifications
- **Phase 3**: Multi-agent support via OpenCode SDK (agent management, streaming transcripts, HITL)
- **Phase 4**: External task sources (Notion API, Peakflo Workflo MCP server, bidirectional sync)

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

[MIT](./LICENSE)
