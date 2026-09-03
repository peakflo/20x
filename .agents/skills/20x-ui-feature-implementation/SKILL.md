---
name: 20x-ui-feature-implementation
description: "Implement UI features across the 20x desktop (Electron/React) and mobile (React) interfaces, keeping both in sync."
confidence: 0.8045
uses: 14
lastUsed: 2026-09-03
tags:
  - ui
  - react
  - electron
  - keyboard-shortcuts
  - command-palette
  - composer-registry
  - input-safety
---

# 20x UI Feature Implementation

## Architecture Overview

20x has two parallel UI codebases that must stay in sync:

- **Desktop (Electron)**: `src/renderer/src/` — React 19 + TailwindCSS 4 + lucide-react icons + @tanstack/react-virtual
- **Mobile (PWA)**: `src/mobile/` — React 19 + TailwindCSS 4 + inline SVG icons (no lucide)

## Key File Mapping

| Feature | Desktop | Mobile |
|---------|---------|--------|
| Agent transcript | `src/renderer/src/components/agents/AgentTranscriptPanel.tsx` | `src/mobile/pages/ConversationPage.tsx` |
| Message rendering | Inline in AgentTranscriptPanel (`MessageBubble`) | `src/mobile/components/MessageBubble.tsx` |
| Agent session hook | `src/renderer/src/hooks/use-agent-session.ts` | Direct store usage |
| Agent store | `src/renderer/src/stores/agent-store.ts` | `src/mobile/stores/agent-store.ts` |
| Task workspace | `src/renderer/src/components/tasks/TaskWorkspace.tsx` | `src/mobile/pages/TaskDetailPage.tsx` |
| Task list item | `src/renderer/src/components/tasks/TaskListItem.tsx` | `src/mobile/components/TaskListItem.tsx` |
| Task detail view | `src/renderer/src/components/tasks/TaskDetailView.tsx` | Inline in `TaskDetailPage.tsx` |
| Subtasks section | Inline in `TaskDetailView.tsx` (SubtasksSection) | Inline in `TaskDetailPage.tsx` (SubtasksSection) |
| Sidebar task list | `src/renderer/src/components/tasks/TaskList.tsx` | N/A |
| Orchestrator | `src/renderer/src/components/orchestrator/OrchestratorPanel.tsx` | N/A |
| Dashboard | `src/renderer/src/components/dashboard/DashboardWorkspace.tsx` | N/A |
| Dashboard Kanban | `src/renderer/src/components/dashboard/TaskBoard.tsx` | N/A |

## Implementation Pattern

### 1. Desktop First
- Desktop uses `@tanstack/react-virtual` for virtualized scrolling in AgentTranscriptPanel
- Use `lucide-react` icons on desktop
- Desktop AgentTranscriptPanel receives `messages`, `status`, `onStop`, `onRestart`, `onSend` as props

### 2. Mobile Mirror
- Mobile does NOT use virtualization (simple `.map()` rendering)
- Mobile uses inline SVG instead of lucide-react (to keep bundle small)
- Mobile ConversationPage manages its own session lifecycle via `useSessionControls` hook
- Mobile uses `cn()` utility from `../lib/utils` for conditional classes

### 3. Scrolling Patterns
- **Desktop**: Uses `useVirtualizer` with `scrollToIndex(messages.length - 1, { align: 'end' })` for jumping to bottom
- **Mobile**: Uses native `scrollRef.current.scrollTo({ top: scrollHeight, behavior: 'smooth' })`
- Both track "at bottom" state via a ref (`atBottomRef` / `isAtBottomRef`) with a threshold (80-100px)
- Auto-scroll only fires when user is already near bottom

### 4. Shared Types
- `SessionStatus` enum defined in `src/shared/constants.ts` (canonical source) and also in `renderer/stores/agent-store.ts` and `mobile/stores/agent-store.ts`
- `AgentMessage` type defined in respective agent stores
- Use enum values (`SessionStatus.IDLE`, `SessionStatus.WORKING`, etc.) not string literals
- IPC events from main process arrive as strings and are cast via `as SessionStatus`
- When adding new enums/types used across main + renderer + mobile, put them in `src/shared/constants.ts`

## Task Completion Path (source-backed tasks)

Completion is **not** just `updateTask({ status: Completed })`. A task with a
`source_id` also pushes the completion to its external system (Linear, Jira,
GitHub, Peakflo) through the plugin action layer.

| Layer | Path |
|---|---|
| Plugin interface | `src/main/plugins/types.ts` — `TaskSourcePlugin.executeAction` |
| Action ids | `src/shared/constants.ts` — `PluginActionId` enum (`Complete`, `Approve`, `CloseIssue`, …) |
| Plugins | `src/main/plugins/{linear,notion,youtrack,github-issues,hubspot,peakflo}-plugin.ts` |
| IPC | `plugin:executeAction` in `ipc-handlers.ts` → `syncManager.executeAction` |
| Store | `useTaskSourceStore.executeAction(actionId, taskId, sourceId, input?)` |

Action id resolution: the task's `action` output field when present, else
`PluginActionId.Complete`.

```ts
const actionField = task.output_fields.find((f) => f.id === 'action')
const actionValue = actionField?.value ? String(actionField.value) : PluginActionId.Complete
```

**There are exactly two renderer call sites**, and they drift:
- `AppLayout.tsx` → `completeTask()` (has toast + select-next-task)
- `canvas/TaskPanelContent.tsx` → `handleCompleteTask()` (silent)

Everything funnels into them through the `onCompleteTask` prop:
`TaskWorkspace` (incl. `handleStatusChange` for `Completed` and
`handleFeedbackSkip`) → `TaskDetailView` → `OutputFieldsDisplay` /
`TaskHeaderBar`. Change the shared hook, not the leaves.

Mobile (`src/mobile/pages/TaskDetailPage.tsx`) **never** ran the source path —
it only sets local status. Do not mirror source-completion work to mobile
without wiring the REST layer first.

Backend auto-completion (`agent-manager` on session idle,
`auto_complete_without_review`) bypasses the renderer entirely, so renderer-side
prompts correctly never fire when no user is present.

## Hook-owns-its-dialog Pattern

When two call sites duplicate logic that must now ask the user something, do
**not** add a modal to `ui-store` and re-plumb both. Extract one hook that
returns the action *and* the rendered dialog:

```tsx
export function useTaskCompletion({ onToast }: Options = {}) {
  const [pending, setPending] = useState<{ taskId: string; options?: O } | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  // ...
  const completionDialog: ReactNode = <CompleteAtSourceDialog isOpen={pending !== null} ... />
  return { requestComplete, completionDialog }
}
```

Call site becomes two lines:
```tsx
const { requestComplete, completionDialog } = useTaskCompletion({ onToast: showToast })
// ... later in JSX:
{completionDialog}
```

Rules that made this correct:
- **Store the id, not the object.** `pending` holds `taskId`; look the task up in
  the store at answer time. A snapshot goes stale when a sync lands while the
  dialog is open.
- **Guard re-entry with `isBusy`** and disable every button, so a double-click
  cannot fire the plugin action twice.
- **Keep the dialog open on failure.** The external call failing must not set
  local status — otherwise the two systems silently diverge. Toast the error and
  let the user retry or switch to the manual path.
- Hooks run before any early `return` in the component (`if (!task) return …`),
  so hook order stays stable.

## Three-button AlertDialog

`AlertDialog` (`@/components/ui/AlertDialog`) is the confirm primitive — see
`DeleteConfirmDialog.tsx` for the two-button baseline. For a three-way choice,
keep `AlertDialogCancel` and add plain `Button`s:

```tsx
<AlertDialogFooter className="flex-col-reverse sm:flex-row sm:justify-end">
  <AlertDialogCancel disabled={isBusy} onClick={onCancel}>Cancel</AlertDialogCancel>
  <Button variant="outline" disabled={isBusy} onClick={onManual}>I'll do it manually</Button>
  <Button disabled={isBusy} onClick={onAtSource}>Complete at source</Button>
</AlertDialogFooter>
```

- `AlertDialogAction` is hardcoded to `variant: 'destructive'` — use a bare
  `Button` for a non-destructive primary.
- Put the variable text (source name) in the **title**, keep button labels fixed
  and short. `Complete in {sourceName}` overflows once a source is named
  "Linear — Engineering Board".
- Add `data-testid` to the content and both action buttons; label text changes
  break tests otherwise.
- Guard `onOpenChange`: `(open) => !open && !isBusy && onCancel()`.

## Dashboard Modal Pattern

The dashboard uses a preview modal system managed by UIStore:
- `dashboardPreviewTaskId: string | null` — tracks which task is being previewed
- `openDashboardPreview(taskId)` — opens the modal with a full TaskWorkspace
- `closeDashboardPreview()` — closes the modal
- **Important**: When deleting a task that is being previewed, always call `closeDashboardPreview()` if `dashboardPreviewTaskId === deletingTaskId` to avoid showing an empty modal
- **Important**: Any UIStore action that navigates away from the dashboard (e.g., `openTaskOnCanvas`, `openAppOnCanvas`) must include `dashboardPreviewTaskId: null` in its state update to close the preview modal. Forgetting this leaves the modal open behind the new view.
- The modal is rendered in `AppLayout.tsx` as a `<Dialog>` containing `<TaskWorkspace>`

## Drag-and-Drop Pattern (Subtasks Reordering)

### Desktop — @dnd-kit
Use `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`:

```tsx
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// Individual sortable item
function SortableItem({ item }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  return (
    <div ref={setNodeRef} style={style}>
      <button className="cursor-grab" {...attributes} {...listeners}><GripVertical /></button>
      {/* Item content */}
    </div>
  )
}

// Container with sensors
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
)
```

### Mobile — Touch-based Long Press
No external library needed. Use long-press (300ms) + touch move to detect reorder:

```tsx
const [dragIndex, setDragIndex] = useState<number | null>(null)
const [overIndex, setOverIndex] = useState<number | null>(null)
const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

// onTouchStart: start timer, onTouchMove: update overIndex, onTouchEnd: commit reorder
// Cancel long press if finger moves > 10px before activation
// Show visual preview by reordering display array
```

### Full-Stack Reorder API
When adding reorder capability, wire up the full stack:
1. **Database** (`database.ts`): `reorderSubtasks(parentId, orderedIds)` — transactional batch update of `sort_order`
2. **IPC handler** (`ipc-handlers.ts`): `db:reorderSubtasks`
3. **Preload** (`preload/index.ts`): Bridge method
4. **Desktop API** (`ipc-client.ts`): `taskApi.reorderSubtasks()`
5. **Mobile REST** (`mobile-api-server.ts`): `POST /api/tasks/reorder-subtasks`
6. **Mobile client** (`mobile/api/client.ts`): `api.tasks.reorderSubtasks()`
7. **Optimistic update**: Update local state immediately, re-fetch on error

### New Item Ordering
When creating items that belong to an ordered list, always set `sort_order = MAX(sort_order) + 1` in the database, not the default 0:
```sql
SELECT COALESCE(MAX(sort_order), -1) as max_order FROM tasks WHERE parent_task_id = ?
```

## Enum Convention

Use enums for status-like values, not type aliases with string literals:

```typescript
// Good
export enum SessionStatus {
  IDLE = 'idle',
  WORKING = 'working',
  ERROR = 'error',
  WAITING_APPROVAL = 'waiting_approval',
}

// Bad
export type SessionStatus = 'idle' | 'working' | 'error' | 'waiting_approval'
```

When comparing, use enum members:
```typescript
// Good
if (status === SessionStatus.IDLE) { ... }

// Bad
if (status === 'idle') { ... }
```

## Styling Conventions

- Dark background: `bg-[#0d1117]` (panel), `bg-[#161b22]` (cards/bubbles)
- Borders: `border-border/50`, `border-border/30`
- Text: `text-foreground`, `text-muted-foreground`, `text-gray-300`
- Status colors: green-400 (working), red-400 (error), yellow-400 (waiting), muted-foreground (idle)
- Floating UI elements: `absolute`, `rounded-full`, `shadow-lg`, `opacity-80 hover:opacity-100`, `transition-all duration-200`

## Consumers of AgentTranscriptPanel

When changing the props interface, update all consumers:
- `TaskWorkspace.tsx` — passes `session.status` directly
- `OrchestratorPanel.tsx` — passes `currentSession?.status || SessionStatus.IDLE`

## Sidebar Search Pattern

When adding search to a sidebar list (tasks, skills, etc.):

1. **UI Store** (`src/renderer/src/stores/ui-store.ts`): Add `xyzSearchQuery: string` state + `setXyzSearchQuery` setter
2. **Sidebar** (`src/renderer/src/components/layout/Sidebar.tsx`): Add search input with `<Search>` icon and clear `<X>` button, plus a `useMemo` filter
3. **List component**: Accept optional `emptyMessage` prop for contextual "no results" vs "no items" messaging
4. **Search fields**: Filter by name, description, and tags (case-insensitive `.toLowerCase().includes(q)`)

Desktop search input pattern:
```tsx
<div className="no-drag px-3 pb-3">
  <div className="relative">
    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
    <input
      type="search"
      value={searchQuery}
      onChange={(e) => setSearchQuery(e.target.value)}
      placeholder="Search items..."
      className="w-full rounded-md border border-input bg-transparent pl-9 pr-8 py-2 text-sm placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/30"
    />
    {searchQuery && (
      <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
        <X className="h-3.5 w-3.5" />
      </button>
    )}
  </div>
</div>
```

Mobile search uses inline SVGs instead of lucide icons and local `useState` instead of Zustand store.

## Key File Mapping (Extended)

| Feature | Desktop | Mobile |
|---------|---------|--------|
| Skill list | `src/renderer/src/components/skills/SkillList.tsx` | `src/mobile/pages/SkillSelectorPage.tsx` |
| Sidebar search | `src/renderer/src/components/layout/Sidebar.tsx` | Local state in page components |
| UI state (search) | `src/renderer/src/stores/ui-store.ts` | Local `useState` |

## Database Schema Changes — Mirror Checklist

When adding a column to the `tasks` table, you MUST update ALL of these locations:

1. **`src/main/database.ts`** — `CREATE TABLE` schema, `TaskRow` interface, `TaskRecord` interface, `UpdateTaskData` interface, `UPDATABLE_COLUMNS` set, `deserializeTask()` function
2. **`src/main/recurrence-scheduler.ts`** — `RawTaskRow` interface AND `deserializeTaskRow()` method (separate copy!)
3. **`test/helpers/db-test-helper.ts`** — In-memory test schema (separate `CREATE TABLE` copy!)
4. **`src/renderer/src/types/index.ts`** — `WorkfloTask` interface, `UpdateTaskDTO` interface
5. **`src/mobile/stores/task-store.ts`** — `Task` interface
6. **Test fixture factories** — `makeWorkfloTask()` in `use-tasks.test.tsx`, `makeRendererTask()` in `TaskWorkspace.test.tsx`
7. **Migration block** in `database.ts` — `ALTER TABLE ADD COLUMN` with `columnNames.has()` guard

Missing any of these causes CI failures (TypeScript errors or SQLite "no column" errors).

### Confirmed refinements (2026-08-13, adding `complete_at_source`)

- `database.ts` has **two** `CREATE TABLE tasks` statements. Patch both.
- Also add to **`CreateTaskData`**, not only `UpdateTaskData`.
- `updateTask()` needs **no** extra serialization code: it already maps
  `boolean → 1/0` and passes `null` through. A nullable boolean column works
  as soon as it is in `UPDATABLE_COLUMNS`.
- Item 6 is bigger than the two factories named above. Find them all:
  ```bash
  grep -rln "auto_complete_without_review" src --include="*.test.ts" --include="*.test.tsx"
  ```
  That was **10 files** — Canvas, Dashboard, TaskDetailView, TaskForm,
  TaskHeaderBar, TaskWorkspace, use-agent-auto-start, use-task-completion,
  use-tasks, dashboard-store. Patch them with one scripted `re.sub` that
  inserts the new field after an existing one, preserving indent and comma.
- `normalizeTask()` in `task-store.ts` spreads `...task`, so new fields survive
  with no change there.
- **Verify the migration against real data before shipping**, not only the test
  schema:
  ```bash
  cp ~/Library/Application\ Support/20x/pf-desktop.db /tmp/mig-test.db
  sqlite3 /tmp/mig-test.db "ALTER TABLE tasks ADD COLUMN <col> INTEGER DEFAULT NULL;"
  sqlite3 /tmp/mig-test.db "SELECT count(*), sum(<col> IS NULL) FROM tasks;"
  ```
- Typecheck is the reliable detector for a missed mirror location. Lint is not.

### Nullable tri-state beats boolean for "has the user answered?"

`null` / `true` / `false` lets every pre-existing row and every unattended code
path keep the old behaviour, while only an explicit answer changes anything.
A `NOT NULL DEFAULT 0` column would silently flip every existing task to the
new behaviour on migration.

## Testing

- Test files use `.test.tsx` / `.test.ts` suffix
- Desktop tests: `src/renderer/src/components/tasks/TaskWorkspace.test.tsx`
- Desktop skill tests: `src/renderer/src/components/skills/SkillList.test.tsx`
- Mobile tests: `src/mobile/stores/agent-store.test.ts`
- When updating enums, update test files to import and use enum values too
- API mock responses can keep string literals since they simulate raw API data
- Use `afterEach(cleanup)` from `@testing-library/react` to prevent DOM leaking between component tests
- When asserting Tailwind classes, beware of `hover:bg-accent/50` containing `bg-accent` — use regex for precise matching

## Dashboard TaskBoard Card Design

The TaskBoard (src/renderer/src/components/dashboard/TaskBoard.tsx) renders a Kanban board with status columns. Key design patterns:

### Card Structure (top to bottom)
1. Title + Priority badge - title is text-[13px], priority as uppercase Badge
2. Description - text-[11px] text-muted-foreground/80 line-clamp-2
3. Labels - muted neutral pills (bg-muted/30 text-muted-foreground), max 3 shown with +N overflow
4. Footer row - due date + source badge on left, agent name/icon + assignee avatar on right

### Column Design
- Each column wrapped in rounded-xl container with subtle tinted background (bg-{color}-500/[0.03])
- Sticky headers with backdrop-blur-md
- Status-specific tint colors: gray (Not Started/Triaging), amber (Agent Working), purple (Ready for Review), blue (Agent Learning)

### Agent Display on Cards
- Look up agent via useAgentStore -> agents array, build Map<string, Agent> by id
- Resolve agent.config.coding_agent (CodingAgentType enum) to proper logo component:
  - CodingAgentType.CLAUDE_CODE -> AnthropicLogo
  - CodingAgentType.OPENCODE -> OpenCodeLogo
  - CodingAgentType.CODEX -> OpenAILogo
- Display agent.name (custom name), NOT the type label
- Logo components are in src/renderer/src/components/icons/AgentLogos.tsx

### Assignee Avatars
- Hash-based consistent color from AVATAR_COLORS array
- Initials: first + last name initial, or first 2 chars
- h-5 w-5 rounded-full with ring-1 ring-white/10

### Source Badges
- Color-coded per provider: Trello (blue), Jira (blue-300), Linear (indigo), Asana (rose), GitHub (gray), Notion (gray)
- Shown as pill with ExternalLink icon

### Priority Left Border
- Cards have border-l-2 with muted priority colors at low opacity: red-500/40 (critical), orange-500/40 (high), amber-400/35 (medium), gray-500/25 (low)

### Dashboard Test Mock Requirements
When a component imports a store that depends on IPC listeners (e.g., useAgentStore uses onAgentStatus), the test vi.mock must include ALL IPC exports that the store calls at initialization time. For agent-store.ts, these are:
- onAgentStatus, onAgentOutput, onAgentOutputBatch, onAgentApproval, onAgentIncompatibleSession
- agentApi with CRUD + session methods

Missing any of these causes: Error: [vitest] No onAgentStatus export is defined on the ipc-client mock

## Global Keyboard Action Pattern

For desktop-wide shortcuts and Command+K actions:

- Confirm the key map with the user before implementation.
- Block plain-key shortcuts in inputs, text areas, selects, content-editable fields, terminals, embedded browsers, and open dialogs.
- Keep Canvas shortcuts isolated so drawing controls have priority.
- Put every global shortcut in the Command+K menu and the shortcut guide.
- Route actions that send agent messages through the live task composer callback. Do not add a parallel window-event or backend path when the composer send path already works.
- Address live composers by task ID because task workspaces can exist in the main view, dashboard preview, and Canvas at the same time.
- Do not change or append to an unfinished draft when a fixed shortcut message is sent.
- Test the shortcut mapping, input guards, live-composer routing, and draft preservation.

