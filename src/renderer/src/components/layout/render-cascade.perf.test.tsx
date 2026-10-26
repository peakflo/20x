/**
 * Re-render cascades in always-mounted, non-canvas UI.
 *
 * Each case drives a store the way the app does at runtime (a streamed agent
 * delta publishes a new `sessions` Map; a `task:updated` push replaces one
 * task in `tasks`; the sidebar polls run durations every 5 s) and counts the
 * work that follows. Counts are deterministic and asserted; commit times come
 * from React's Profiler and are only printed (`[perf] render cascade`).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memo, Profiler, type ProfilerOnRenderCallback, type ReactElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { TaskStatus } from '@/types'
import type { WorkfloTask } from '@/types'

const counts = vi.hoisted(() => ({ workspace: 0, listItem: 0 }))

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

import { useTaskStore } from '@/stores/task-store'
import { useAgentStore, SessionStatus } from '@/stores/agent-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskList } from '@/components/tasks/TaskList'
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard'
import { AppLayout } from './AppLayout'
import { useUiRemoteControl } from '@/hooks/use-ui-remote-control'

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
    try {
    const tasks = Array.from({ length: 300 }, (_, i) => makeTask(i))
    useTaskStore.setState({ tasks, selectedTaskId: 't0', isLoading: false })
    useUIStore.setState({ sidebarView: 'tasks', activeModal: null, dashboardPreviewTaskId: null })
    render(<AppLayout />)
    await act(async () => { await Promise.resolve() })
    const before = counts.workspace
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
    expect(perUpdate).toBe(0)
    } finally {
      cleanup()
      ;(window as unknown as { electronAPI: unknown }).electronAPI = original
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
