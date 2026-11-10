/**
 * Re-render cascades in always-mounted, non-canvas UI.
 *
 * Each case drives a store the way the app does at runtime (a streamed agent
 * delta publishes a new `sessions` Map; a `task:updated` push replaces one
 * task in `tasks`; the sidebar polls run durations every 5 s) and counts the
 * work that follows. Counts are deterministic and asserted; commit times come
 * from React's Profiler and are only printed (`[perf] render cascade`).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { memo, Profiler, type ProfilerOnRenderCallback, type ReactElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

const counts = vi.hoisted(() => ({ workspace: 0, listItem: 0, palette: 0 }))

vi.mock('@/components/tasks/TaskWorkspace', () => ({
  TaskWorkspace: memo(function CountingTaskWorkspace() {
    counts.workspace++
    return <div data-testid="workspace" />
  })
}))
vi.mock('@/components/canvas/InfiniteCanvas', () => ({ InfiniteCanvas: () => null }))
vi.mock('./Sidebar', () => ({ Sidebar: () => null }))
vi.mock('@/components/tasks/TaskListItem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/tasks/TaskListItem')>()
  const inner = (actual.TaskListItem as unknown as { type: (p: unknown) => ReactElement }).type
  const compare = (actual.TaskListItem as unknown as { compare?: (a: unknown, b: unknown) => boolean }).compare
  return {
    ...actual,
    TaskListItem: memo(function CountingTaskListItem(props: unknown) {
      counts.listItem++
      return inner(props)
    }, compare)
  }
})

// Count CommandPalette renders without changing it (works whether or not it is memoized).
vi.mock('./CommandPalette', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./CommandPalette')>()
  const wrapped = actual.CommandPalette as unknown as { type?: (p: unknown) => ReactElement; compare?: (a: unknown, b: unknown) => boolean }
  const inner = wrapped.type ?? (actual.CommandPalette as unknown as (p: unknown) => ReactElement)
  function CountingCommandPalette(props: unknown): ReactElement {
    counts.palette++
    return inner(props)
  }
  return { ...actual, CommandPalette: wrapped.type ? memo(CountingCommandPalette, wrapped.compare) : CountingCommandPalette }
})

import { useTaskStore } from '@/stores/task-store'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskList } from '@/components/tasks/TaskList'
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard'
import { AppLayout } from './AppLayout'
import { useUiRemoteControl } from '@/hooks/use-ui-remote-control'
import { useTasks } from '@/hooks/use-tasks'
import { CommandPalette, type CommandPaletteActions } from './CommandPalette'
import { TaskPanelContent } from '@/components/canvas/TaskPanelContent'
import { DashboardWorkspace } from '@/components/dashboard/DashboardWorkspace'
import type { AgentStatusEvent } from '@/types/electron'

// Mounting AppLayout/DashboardWorkspace and the fake-timer poll loops can
// exceed vitest's 5 s default on a loaded machine; a timed-out case keeps
// running in the background and breaks the cases after it.
vi.setConfig({ testTimeout: 30_000 })

const results: Record<string, string | number> = {}
afterAll(() => {
  console.log('[perf] render cascade\n' + Object.entries(results).map(([k, v]) => `  ${k}: ${v}`).join('\n'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function makeTask(i: number, status: TaskStatus = TaskStatus.NotStarted): WorkfloTask {
  return {
    id: `t${i}`,
    title: `Task ${i}`,
    description: '',
    status,
    priority: 'medium',
    type: 'general',
    assignee: '',
    created_at: new Date(1_750_000_000_000 + i * 1000).toISOString(),
    updated_at: new Date(1_750_000_000_000 + i * 1000).toISOString(),
    labels: [],
    attachments: [],
    repos: [],
    output_fields: [],
    parent_task_id: null,
    sort_order: 0
  } as unknown as WorkfloTask
}

/** One streamed delta for `taskId`, published the way agent-store does (new Map). */
function streamDelta(taskId: string, n: number): void {
  useAgentStore.setState((s) => {
    const sessions = new Map(s.sessions)
    const prev = sessions.get(taskId)
    sessions.set(taskId, {
      ...(prev ?? { sessionId: 's1', agentId: 'a1', taskId, status: SessionStatus.WORKING, messages: [] }),
      messages: [{ id: 'live', role: 'assistant', content: `token ${n}`, timestamp: new Date(0), partType: 'text' }]
    } as never)
    return { sessions }
  })
}

/**
 * Swap in a window.electronAPI whose missing namespaces/methods resolve to
 * no-ops, so components that wire many IPC listeners can mount. Returns the
 * restore function.
 */
function fillElectronAPI(): () => void {
  const original = window.electronAPI
  const asyncNoop = (): Promise<undefined> => Promise.resolve(undefined)
  const fill = (target: Record<string, unknown>, depth: number): Record<string, unknown> => new Proxy(target, {
    get(obj, key: string) {
      if (key in obj) {
        const value = obj[key]
        return depth === 0 && value && typeof value === 'object' ? fill(value as Record<string, unknown>, 1) : value
      }
      if (typeof key !== 'string' || key === 'then') return undefined
      if (key.startsWith('on')) return () => () => {}
      return depth === 0 ? fill({}, 1) : asyncNoop
    }
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = fill(original as unknown as Record<string, unknown>, 0)
  return () => { (window as unknown as { electronAPI: unknown }).electronAPI = original }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

describe('render cascade benchmark', () => {
  beforeEach(() => {
    counts.workspace = 0
    counts.listItem = 0
    useAgentStore.setState({ sessions: new Map() })
  })

  it('AppLayout: selected TaskWorkspace re-renders per unrelated task update', async () => {
    // AppLayout wires many IPC listeners; fill in any the shared mock lacks.
    const restore = fillElectronAPI()
    try {
    const tasks = Array.from({ length: 300 }, (_, i) => makeTask(i))
    useTaskStore.setState({ tasks, selectedTaskId: 't0', isLoading: false })
    useUIStore.setState({ sidebarView: 'tasks', activeModal: null, dashboardPreviewTaskId: null })
    render(<AppLayout />)
    await act(async () => { await Promise.resolve() })
    const before = counts.workspace
    const paletteBefore = counts.palette
    expect(before).toBeGreaterThan(0)

    const UPDATES = 50
    for (let i = 0; i < UPDATES; i++) {
      act(() => {
        useTaskStore.setState((s) => ({
          tasks: s.tasks.map((t) => (t.id === 't5' ? { ...t, updated_at: new Date(2_000_000_000_000 + i).toISOString() } : t))
        }))
      })
    }
    const perUpdate = (counts.workspace - before) / UPDATES
    results['AppLayout: TaskWorkspace renders per unrelated task:updated'] = perUpdate
    const palettePerUpdate = (counts.palette - paletteBefore) / UPDATES
    results['AppLayout: closed CommandPalette renders per task:updated'] = palettePerUpdate
    expect(perUpdate).toBe(0)
    expect(palettePerUpdate).toBe(0)
    } finally {
      cleanup()
      restore()
    }
  })

  it('TaskList: rows re-rendered per 5 s run-duration poll (500 tasks, 1 running)', async () => {
    vi.useFakeTimers()
    const tasks = Array.from({ length: 500 }, (_, i) => makeTask(i))
    let poll = 0
    const api = window.electronAPI as unknown as { tasks: Record<string, unknown> }
    api.tasks = {
      ...(api.tasks ?? {}),
      getRunDurations: vi.fn(async (ids: string[]) => {
        poll++
        const out: Record<string, { durationMs: number; isRunning: boolean }> = {}
        // Every task has a finished history; t0 is running and grows each poll.
        for (const id of ids) out[id] = { durationMs: 60_000, isRunning: false }
        out.t0 = { durationMs: 60_000 + poll * 5000, isRunning: true }
        return out
      })
    }
    const commits: number[] = []
    const onRender: ProfilerOnRenderCallback = (_id, _phase, duration) => { commits.push(duration) }
    render(
      <Profiler id="list" onRender={onRender}>
        <TaskList tasks={tasks} selectedTaskId={null} onSelectTask={() => {}} />
      </Profiler>
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const POLLS = 6
    const rowsPerPoll: number[] = []
    const msPerPoll: number[] = []
    for (let i = 0; i < POLLS; i++) {
      const rows = counts.listItem
      const c = commits.length
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      rowsPerPoll.push(counts.listItem - rows)
      msPerPoll.push(commits.slice(c).reduce((a, b) => a + b, 0))
    }
    delete api.tasks.getRunDurations
    results['TaskList: rows re-rendered per 5 s poll (500 rows, 1 running)'] = median(rowsPerPoll)
    results['TaskList: commit ms per 5 s poll (median)'] = median(msPerPoll).toFixed(2)
    expect(median(rowsPerPoll)).toBeLessThanOrEqual(1)
  })

  it('OnboardingWizard (closed, always mounted): renders per streamed agent delta', () => {
    let renders = 0
    const commits: number[] = []
    render(
      <Profiler id="wizard" onRender={(_id, _phase, d) => { renders++; commits.push(d) }}>
        <OnboardingWizard open={false} onOpenChange={() => {}} />
      </Profiler>
    )
    const start = renders
    const DELTAS = 100
    for (let i = 0; i < DELTAS; i++) act(() => streamDelta('t1', i))
    const per = (renders - start) / DELTAS
    results['OnboardingWizard (closed): renders per streamed delta'] = per
    results['OnboardingWizard (closed): total commit ms per 100 deltas'] = commits.slice(start).reduce((a, b) => a + b, 0).toFixed(2)
    expect(per).toBe(0)
  })

  it('useUiRemoteControl: publishState IPC calls during 10 s of streaming at 20 deltas/s', async () => {
    vi.useFakeTimers()
    useTaskStore.setState({ tasks: Array.from({ length: 300 }, (_, i) => makeTask(i)), selectedTaskId: 't0' })
    const api = window.electronAPI as unknown as { ui?: unknown }
    const previousUi = api.ui
    const publishState = vi.fn(async () => undefined)
    api.ui = { publishState, sendCommandResult: vi.fn(async () => undefined), onCommand: () => () => {} }
    function Harness(): null { useUiRemoteControl(); return null }
    render(<Harness />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    const start = publishState.mock.calls.length
    for (let i = 0; i < 200; i++) {
      act(() => streamDelta('t1', i))
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    const calls = publishState.mock.calls.length - start
    api.ui = previousUi
    results['useUiRemoteControl: publishState IPC calls per 10 s stream (unrelated task)'] = calls
    expect(calls).toBe(0)
  })
})

/** A `task:updated` push for `id` that changes `updated_at` (what the store does on any real change). */
function bumpTask(id: string, n: number): void {
  useTaskStore.setState((s) => ({
    tasks: s.tasks.map((t) => (t.id === id ? { ...t, updated_at: new Date(2_000_000_000_000 + n).toISOString() } : t))
  }))
}

/** Listener the task/agent store registered on the shared electronAPI mock at import time. */
function registeredListener<T>(fn: unknown): T {
  const calls = (fn as Mock).mock.calls
  return calls[calls.length - 1][0] as T
}

const noopActions = new Proxy({}, { get: () => () => {} }) as CommandPaletteActions

describe('full-task-list subscriptions and redundant store updates', () => {
  const UPDATES = 30
  let originalFetchTasks: () => Promise<void>

  beforeEach(() => {
    originalFetchTasks = useTaskStore.getState().fetchTasks
    // useTasks/AppLayout fetch on mount; keep the seeded task list.
    useTaskStore.setState({ fetchTasks: async () => {} })
    useAgentStore.setState({ sessions: new Map() })
  })
  afterEach(() => {
    useTaskStore.setState({ fetchTasks: originalFetchTasks })
  })

  for (const size of [500, 2000]) {
    for (const sortField of ['created_at', 'updated_at'] as const) {
      it(`useTasks: commit ms per task:updated (${size} tasks, ${sortField} sort)`, () => {
        // created_at follows store order; updated_at is scrambled (real lists
        // are touched in arbitrary order), which is where sorting costs most.
        const tasks = Array.from({ length: size }, (_, i) => ({
          ...makeTask(i),
          updated_at: new Date(1_750_000_000_000 + ((i * 7919) % size) * 1000).toISOString()
        }))
        useTaskStore.setState({ tasks, selectedTaskId: null })
        useUIStore.setState({ sortField, sortDirection: 'desc', searchQuery: '', statusFilter: 'all', priorityFilter: 'all', sourceFilter: 'all', reviewUnseenOnly: false })
        function Harness(): null { useTasks(); return null }
        const commits: number[] = []
        render(<Profiler id="useTasks" onRender={(_id, _p, d) => { commits.push(d) }}><Harness /></Profiler>)
        const start = commits.length
        for (let i = 0; i < UPDATES; i++) act(() => bumpTask('t5', i))
        const per = commits.slice(start)
        results[`useTasks (${size} tasks, ${sortField} desc): commit ms per task:updated (median)`] = median(per).toFixed(3)
        expect(per.length).toBe(UPDATES)
      })
    }
  }

  it('CommandPalette (closed, always mounted): renders per task:updated (500 tasks)', () => {
    useTaskStore.setState({ tasks: Array.from({ length: 500 }, (_, i) => makeTask(i)) })
    let renders = 0
    const commits: number[] = []
    render(
      <Profiler id="palette" onRender={(_id, _p, d) => { renders++; commits.push(d) }}>
        <CommandPalette open={false} onOpenChange={() => {}} actions={noopActions} />
      </Profiler>
    )
    const start = renders
    for (let i = 0; i < UPDATES; i++) act(() => bumpTask('t5', i))
    const per = (renders - start) / UPDATES
    results['CommandPalette (closed, 500 tasks): renders per task:updated'] = per
    results['CommandPalette (closed, 500 tasks): commit ms per task:updated (median)'] = median(commits.slice(start)).toFixed(3)
    expect(per).toBe(0)
  })

  it('canvas: TaskPanelContent renders per task:updated with 20 panels (500 tasks)', () => {
    useTaskStore.setState({ tasks: Array.from({ length: 500 }, (_, i) => makeTask(i)), selectedTaskId: null })
    const PANELS = 20
    let renders = 0
    const commits: number[] = []
    const onRender: ProfilerOnRenderCallback = (_id, _p, d) => { renders++; commits.push(d) }
    render(
      <>
        {Array.from({ length: PANELS }, (_, i) => (
          <Profiler key={i} id={`panel-${i}`} onRender={onRender}>
            <TaskPanelContent panelId={`p${i}`} taskId={`t${i}`} />
          </Profiler>
        ))}
      </>
    )
    // Unrelated task (not on the canvas).
    let start = renders
    let c = commits.length
    for (let i = 0; i < UPDATES; i++) act(() => bumpTask('t100', i))
    const unrelated = (renders - start) / UPDATES
    const unrelatedMs = commits.slice(c).reduce((a, b) => a + b, 0) / UPDATES
    // A task that IS on the canvas: only its own panel should render.
    start = renders
    c = commits.length
    for (let i = 0; i < UPDATES; i++) act(() => bumpTask('t3', i))
    const own = (renders - start) / UPDATES
    const ownMs = commits.slice(c).reduce((a, b) => a + b, 0) / UPDATES
    results['canvas 20 panels: panel renders per unrelated task:updated'] = unrelated
    results['canvas 20 panels: commit ms per unrelated task:updated (mean)'] = unrelatedMs.toFixed(3)
    results['canvas 20 panels: panel renders per on-canvas task:updated'] = own
    results['canvas 20 panels: commit ms per on-canvas task:updated (mean)'] = ownMs.toFixed(3)
    expect(unrelated).toBe(0)
    expect(own).toBe(1)
  })

  it('DashboardWorkspace: completed-stats DB queries per task:updated (500 tasks)', async () => {
    const restore = fillElectronAPI()
    const getStats = (window.electronAPI.db as unknown as { getCompletedTaskStats: Mock }).getCompletedTaskStats
    try {
      useTaskStore.setState({ tasks: Array.from({ length: 500 }, (_, i) => makeTask(i)) })
      render(<DashboardWorkspace />)
      await vi.waitFor(() => expect(getStats).toHaveBeenCalled())
      await act(async () => { await Promise.resolve() })
      const start = getStats.mock.calls.length
      for (let i = 0; i < UPDATES; i++) {
        act(() => bumpTask('t5', i))
        await act(async () => { await Promise.resolve() })
      }
      const unrelated = (getStats.mock.calls.length - start) / UPDATES
      results['Dashboard: getCompletedTaskStats queries per open-task task:updated'] = unrelated
      // Completing a task changes completed history: it must still re-query.
      const before = getStats.mock.calls.length
      act(() => {
        useTaskStore.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === 't7' ? { ...t, status: TaskStatus.Completed } : t)) }))
      })
      await act(async () => { await Promise.resolve() })
      const onComplete = getStats.mock.calls.length - before
      results['Dashboard: getCompletedTaskStats queries when a task completes'] = onComplete
      expect(unrelated).toBe(0)
      expect(onComplete).toBe(1)
    } finally {
      cleanup()
      restore()
    }
  })

  it('task:updated push that changes nothing: store notifications and useTasks renders (500 tasks)', () => {
    useTaskStore.setState({ tasks: Array.from({ length: 500 }, (_, i) => makeTask(i)), selectedTaskId: null })
    const onTaskUpdated = registeredListener<(e: { taskId: string; updates: Partial<WorkfloTask> }) => void>(window.electronAPI.onTaskUpdated)
    // The seeded fixture is not normalized like store records are; one real
    // push normalizes it (skill_ids etc.).
    onTaskUpdated({ taskId: 't5', updates: { title: 'Task 5' } })
    let notifications = 0
    const unsub = useTaskStore.subscribe(() => { notifications++ })
    function Harness(): null { useTasks(); return null }
    let renders = 0
    const commits: number[] = []
    render(<Profiler id="useTasks" onRender={(_id, _p, d) => { renders++; commits.push(d) }}><Harness /></Profiler>)
    const startRenders = renders
    const PUSHES = 20
    for (let i = 0; i < PUSHES; i++) {
      const current = useTaskStore.getState().tasks.find((t) => t.id === 't5')!
      // Main often re-sends the whole DB record (`updates: db.getTask(id)`),
      // which arrives as fresh arrays/objects with equal values.
      act(() => onTaskUpdated({ taskId: 't5', updates: JSON.parse(JSON.stringify(current)) }))
      act(() => onTaskUpdated({ taskId: 't5', updates: { status: current.status } }))
    }
    unsub()
    results['redundant task:updated: store notifications per push'] = notifications / (PUSHES * 2)
    results['redundant task:updated: useTasks renders per push'] = (renders - startRenders) / (PUSHES * 2)
    results['redundant task:updated: useTasks commit ms per push (mean)'] = (commits.slice(startRenders).reduce((a, b) => a + b, 0) / (PUSHES * 2)).toFixed(3)
    expect(notifications).toBe(0)
    // A real change still lands.
    act(() => onTaskUpdated({ taskId: 't5', updates: { title: 'renamed' } }))
    expect(useTaskStore.getState().tasks.find((t) => t.id === 't5')?.title).toBe('renamed')
  })

  it('agent:status push that changes nothing: store notifications and sessions subscriber renders', () => {
    useAgentStore.setState({
      sessions: new Map([['t1', { sessionId: 's1', agentId: 'a1', taskId: 't1', status: SessionStatus.WORKING, messages: [], pendingApproval: null }]])
    } as never)
    const onAgentStatus = registeredListener<(e: AgentStatusEvent) => void>(window.electronAPI.onAgentStatus)
    let notifications = 0
    const unsub = useAgentStore.subscribe(() => { notifications++ })
    let renders = 0
    function Harness(): null { useAgentStore((s) => s.sessions); renders++; return null }
    render(<Harness />)
    const startRenders = renders
    const PUSHES = 20
    for (let i = 0; i < PUSHES; i++) {
      act(() => onAgentStatus({ sessionId: 's1', agentId: 'a1', taskId: 't1', status: SessionStatus.WORKING } as AgentStatusEvent))
    }
    unsub()
    results['redundant agent:status: store notifications per push'] = notifications / PUSHES
    results['redundant agent:status: sessions-subscriber renders per push'] = (renders - startRenders) / PUSHES
    expect(notifications).toBe(0)
    // A real transition still lands.
    act(() => onAgentStatus({ sessionId: 's1', agentId: 'a1', taskId: 't1', status: SessionStatus.WAITING_APPROVAL } as AgentStatusEvent))
    expect(useAgentStore.getState().sessions.get('t1')?.status).toBe(SessionStatus.WAITING_APPROVAL)
  })
})
