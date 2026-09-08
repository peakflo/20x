import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { AutomationWorkspace } from './AutomationWorkspace'
import { useTaskStore } from '@/stores/task-store'
import { useUIStore } from '@/stores/ui-store'
import { TaskStatus, type WorkfloTask } from '@/types'
import type { ResponsibilitiesApi, ResponsibilityRecord, ResponsibilitySnapshot } from '@shared/responsibilities'

let snapshot: ResponsibilitySnapshot
let changed: () => void
let api: ResponsibilitiesApi
const unsubscribe = vi.fn()

function task(id: string, overrides: Partial<WorkfloTask> = {}): WorkfloTask {
  return {
    id, title: id, description: '', status: TaskStatus.NotStarted, repos: [],
    is_recurring: true, recurrence_parent_id: null, recurrence_mode: 'reuse',
    recurrence_pattern: '0 9 * * *', recurrence_paused: false, auto_start_agent: true,
    next_occurrence_at: '2030-01-02T09:00:00Z', last_occurrence_at: null,
    created_at: '2030-01-01', ...overrides
  } as WorkfloTask
}

function responsibility(id: string, kind: 'goal' | 'routine' | 'task', state: ResponsibilityRecord['state'] = 'active'): ResponsibilityRecord {
  return {
    id, projectId: 'project', state, steps: 2, nextAt: '2030-01-02T09:00:00Z',
    createdAt: '2030-01-01', next: { phase: 'verify', instruction: 'Check the result' },
    agreement: { kind, title: id, objective: 'Follow the agreed scope', maxSteps: 10 }
  } as ResponsibilityRecord
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  useTaskStore.setState({ tasks: [], isLoading: false, error: null })
  useUIStore.setState({ searchQuery: 'unrelated', statusFilter: TaskStatus.Completed, sourceFilter: 'unrelated' })
  snapshot = {
    projects: [{ id: 'project', name: 'Example project', root: '/example', agentId: 'agent', createdAt: '2030-01-01' }],
    responsibilities: [], notices: [], memory: [], steps: []
  }
  api = {
    snapshot: vi.fn(async () => structuredClone(snapshot)),
    onChanged: vi.fn(listener => { changed = listener; return unsubscribe }),
    pickProjectFolder: vi.fn(), createProject: vi.fn(), act: vi.fn(), answer: vi.fn(), remember: vi.fn(), forget: vi.fn()
  }
  window.electronAPI.responsibilities = api
})

it('lists all schedules and project goals/routines without task filters, duplicate runs, or mutation controls', async () => {
  useTaskStore.setState({ tasks: [
    task('Recurring check'), task('Old schedule', { recurrence_mode: 'separate', recurrence_paused: true }),
    task('Completed schedule', { status: TaskStatus.Completed }),
    task('Source schedule', { server_managed: true }),
    task('Individual run', { recurrence_parent_id: 'Old schedule' }),
    task('Ordinary task', { is_recurring: false })
  ] })
  snapshot.responsibilities = [responsibility('Ship feature', 'goal'), responsibility('Project updates', 'routine', 'paused'), responsibility('Finished goal', 'goal', 'completed'), responsibility('One-off request', 'task')]
  const { unmount } = render(<AutomationWorkspace />)
  await screen.findByText('Ship feature')
  expect(screen.getByText('Recurring check')).toBeInTheDocument()
  expect(screen.getByText('Old schedule')).toBeInTheDocument()
  expect(screen.queryByText('Individual run')).not.toBeInTheDocument()
  expect(screen.queryByText('Ordinary task')).not.toBeInTheDocument()
  expect(screen.queryByText('One-off request')).not.toBeInTheDocument()
  const old = within(screen.getByText('Old schedule').closest('tr')!)
  expect(old.getByText('Paused')).toBeInTheDocument()
  expect(old.getByText('Next scheduled: —')).toBeInTheDocument()
  expect(within(screen.getByText('Completed schedule').closest('tr')!).getByText('Completed')).toBeInTheDocument()
  expect(within(screen.getByText('Source schedule').closest('tr')!).getByText('Managed by source')).toBeInTheDocument()
  expect(screen.getAllByText('Goal · Example project')).toHaveLength(2)
  expect(within(screen.getByText('Finished goal').closest('tr')!).queryByText(/Saved next step/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(api.act).not.toHaveBeenCalled()
  expect(window.electronAPI.db.manageScheduleTask).not.toHaveBeenCalled()
  unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('updates from task events and project notifications while the page stays open', async () => {
  render(<AutomationWorkspace />)
  await screen.findByText(/No project goals or routines yet/)
  act(() => useTaskStore.setState({ tasks: [task('New schedule')] }))
  expect(screen.getByText('New schedule')).toBeInTheDocument()
  snapshot.responsibilities = [responsibility('New goal', 'goal', 'proposed')]
  await act(async () => changed())
  expect(await screen.findByText('Awaiting approval')).toBeInTheDocument()
  snapshot.responsibilities[0].state = 'blocked'
  await act(async () => changed())
  expect(await screen.findByText('Blocked')).toBeInTheDocument()
  snapshot.responsibilities = []
  await act(async () => changed())
  expect(screen.queryByText('New goal')).not.toBeInTheDocument()
  expect(screen.getByText('New schedule')).toBeInTheDocument()
  act(() => useTaskStore.setState({ tasks: [] }))
  expect(screen.queryByText('New schedule')).not.toBeInTheDocument()
})

it('shows loading/read errors and recovers without letting an older response replace fresh data', async () => {
  let resolveOld!: (value: ResponsibilitySnapshot) => void
  const old = structuredClone(snapshot)
  old.responsibilities = [responsibility('Stale goal', 'goal')]
  vi.mocked(api.snapshot).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  useTaskStore.setState({ isLoading: true })
  render(<AutomationWorkspace />)
  expect(screen.getByText('Loading scheduled tasks…')).toBeInTheDocument()
  expect(screen.getByText('Loading project goals and routines…')).toBeInTheDocument()
  snapshot.responsibilities = [responsibility('Fresh goal', 'goal')]
  await act(async () => changed())
  await screen.findByText('Fresh goal')
  await act(async () => resolveOld(old))
  expect(screen.queryByText('Stale goal')).not.toBeInTheDocument()
  vi.mocked(api.snapshot).mockRejectedValueOnce(new Error('Read failed'))
  act(() => useTaskStore.setState({ isLoading: false, error: 'Task read failed' }))
  await act(async () => changed())
  expect(await screen.findByText(/Showing the last loaded list/)).toBeInTheDocument()
  expect(screen.getByText(/Could not load scheduled tasks/)).toBeInTheDocument()
  expect(screen.getByText('Fresh goal')).toBeInTheDocument()
  await act(async () => changed())
  await waitFor(() => expect(screen.queryByText(/Could not refresh project/)).not.toBeInTheDocument())
})
