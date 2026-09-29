import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { HeartbeatSection } from './HeartbeatSection'
import type { HeartbeatStatusResult } from '@/types/electron'
import type { WorkfloTask } from '@/types'
import { TaskStatus, HeartbeatStatus } from '@shared/constants'

interface HeartbeatLog {
  id: string
  task_id: string
  status: string
  summary: string | null
  session_id: string | null
  created_at: string
}

const heartbeatApi = {
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  runNow: vi.fn().mockResolvedValue('sent'),
  getLogs: vi.fn().mockResolvedValue([] as HeartbeatLog[]),
  getStatus: vi.fn().mockResolvedValue(null as HeartbeatStatusResult | null),
  updateInterval: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(null as string | null),
  writeFile: vi.fn().mockResolvedValue(true)
}

// Extend the shared electronAPI mock with the heartbeat namespace and the
// heartbeat IPC listener registrars used by `subscribe()`.
const electronAPI = window.electronAPI as unknown as Record<string, unknown>
electronAPI.heartbeat = heartbeatApi
electronAPI.onHeartbeatAlert = vi.fn((_cb: (event: unknown) => void) => vi.fn())
electronAPI.onHeartbeatDisabled = vi.fn((_cb: (event: unknown) => void) => vi.fn())

;(window as unknown as { alert: unknown }).alert = vi.fn()

afterEach(cleanup)

function makeTask(overrides: Partial<WorkfloTask> = {}): WorkfloTask {
  return {
    id: 'task-1',
    title: 'Test task',
    description: '',
    type: 'general',
    priority: 'medium',
    status: TaskStatus.NotStarted,
    assignee: '',
    due_date: null,
    labels: [],
    attachments: [],
    repos: [],
    output_fields: [],
    agent_id: null,
    session_id: null,
    external_id: null,
    source_id: null,
    source: 'local',
    skill_ids: null,
    snoozed_until: null,
    resolution: null,
    feedback_rating: null,
    feedback_comment: null,
    is_recurring: false,
    recurrence_pattern: null,
    recurrence_parent_id: null,
    last_occurrence_at: null,
    next_occurrence_at: null,
    auto_start_agent: false,
    auto_complete_without_review: false,
    complete_at_source: null,
    parent_task_id: null,
    sort_order: 0,
    created_at: '2026-03-28T08:00:00Z',
    updated_at: '2026-03-28T08:00:00Z',
    ...overrides
  }
}

function makeStatus(overrides: Partial<HeartbeatStatusResult> = {}): HeartbeatStatusResult {
  return {
    enabled: false,
    intervalMinutes: 30,
    lastCheckAt: null,
    nextCheckAt: null,
    hasHeartbeatFile: true,
    ...overrides
  }
}

function makeLog(overrides: Partial<HeartbeatLog> = {}): HeartbeatLog {
  return {
    id: 'log-1',
    task_id: 'task-1',
    status: HeartbeatStatus.Ok,
    summary: 'All checks passed',
    session_id: null,
    created_at: '2026-03-28T08:00:00Z',
    ...overrides
  }
}

function openModal() {
  fireEvent.click(screen.getByTitle('Click to edit heartbeat instructions'))
}

beforeEach(() => {
  vi.clearAllMocks()
  heartbeatApi.getStatus.mockResolvedValue(makeStatus())
  heartbeatApi.getLogs.mockResolvedValue([])
  heartbeatApi.readFile.mockResolvedValue('# Heartbeat Checks\n- [ ] Check CI')
  ;(window as unknown as { alert: unknown }).alert = vi.fn()
})

describe('HeartbeatSection', () => {
  it('renders nothing for an ordinary task without heartbeat', async () => {
    heartbeatApi.getStatus.mockResolvedValue(makeStatus({ hasHeartbeatFile: false }))
    const { container } = render(<HeartbeatSection task={makeTask()} />)

    await waitFor(() => expect(heartbeatApi.getStatus).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })

  it('renders setup prompt for a ready-for-review task without heartbeat file', async () => {
    heartbeatApi.getStatus.mockResolvedValue(makeStatus({ hasHeartbeatFile: false }))
    heartbeatApi.readFile.mockResolvedValue(null)
    render(<HeartbeatSection task={makeTask({ status: TaskStatus.ReadyForReview })} />)

    expect(await screen.findByText('Click to set up instructions')).toBeDefined()
    expect(screen.getByText('Heartbeat')).toBeDefined()
  })

  it('shows Off badge and file content for a disabled heartbeat', async () => {
    render(<HeartbeatSection task={makeTask()} />)

    expect(await screen.findByText('Off')).toBeDefined()
    // Markdown renders the checklist item text without the '- [ ]' marker
    expect(screen.getByText('Check CI')).toBeDefined()
    expect(screen.queryByText(/checked/)).toBeNull()
  })

  it('shows the Attention badge and schedule from the last log when enabled', async () => {
    heartbeatApi.getStatus.mockResolvedValue(
      makeStatus({
        enabled: true,
        lastCheckAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        nextCheckAt: new Date(Date.now() + 30 * 60_000).toISOString()
      })
    )
    heartbeatApi.getLogs.mockResolvedValue([
      makeLog({ status: HeartbeatStatus.AttentionNeeded })
    ])

    render(<HeartbeatSection task={makeTask()} />)

    expect(await screen.findByText('Attention')).toBeDefined()
    expect(screen.getByText('Heartbeat')).toBeDefined()
    expect(screen.getByText(/checked/)).toBeDefined()
    expect(screen.getByText(/\. next /)).toBeDefined()
  })

  it('opens the modal prefilled with file content and saves via writeFile', async () => {
    render(<HeartbeatSection task={makeTask()} />)
    await screen.findByText('Off')

    openModal()

    const textarea = await screen.findByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('# Heartbeat Checks\n- [ ] Check CI')

    fireEvent.change(textarea, { target: { value: '# Updated\n- [ ] New check' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(heartbeatApi.writeFile).toHaveBeenCalledWith('task-1', '# Updated\n- [ ] New check')
    })
  })

  it('uses default draft when opening the modal with no file content', async () => {
    heartbeatApi.readFile.mockResolvedValue(null)
    render(<HeartbeatSection task={makeTask({ status: TaskStatus.ReadyForReview })} />)
    await screen.findByText('Click to set up instructions')

    openModal()

    const textarea = await screen.findByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('# Heartbeat Checks\n- [ ] ')
  })

  it('enables the heartbeat from the modal when disabled', async () => {
    render(<HeartbeatSection task={makeTask()} />)
    await screen.findByText('Off')

    openModal()
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))

    await waitFor(() => expect(heartbeatApi.enable).toHaveBeenCalledWith('task-1'))
    expect(heartbeatApi.disable).not.toHaveBeenCalled()
  })

  it('disables the heartbeat from the modal when enabled', async () => {
    heartbeatApi.getStatus.mockResolvedValue(makeStatus({ enabled: true }))
    render(<HeartbeatSection task={makeTask()} />)
    await screen.findByText('Heartbeat')

    openModal()
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))

    await waitFor(() => expect(heartbeatApi.disable).toHaveBeenCalledWith('task-1'))
    expect(heartbeatApi.enable).not.toHaveBeenCalled()
  })

  it('shows Run Now button only when enabled and alerts on no_file', async () => {
    heartbeatApi.getStatus.mockResolvedValue(makeStatus({ enabled: true }))
    heartbeatApi.runNow.mockResolvedValue('no_file')
    render(<HeartbeatSection task={makeTask()} />)
    await screen.findByText('Heartbeat')

    // Run Now lives inside the modal
    openModal()
    fireEvent.click(await screen.findByRole('button', { name: 'Run Now' }))

    await waitFor(() => expect(heartbeatApi.runNow).toHaveBeenCalledWith('task-1'))
    expect(window.alert).toHaveBeenCalledWith('No heartbeat.md file found. Save instructions first.')
  })

  it('updates the interval from the modal select', async () => {
    heartbeatApi.getStatus.mockResolvedValue(makeStatus({ enabled: true }))
    render(<HeartbeatSection task={makeTask()} />)
    await screen.findByText('Heartbeat')

    openModal()
    const select = await screen.findByDisplayValue('30') as HTMLSelectElement
    fireEvent.change(select, { target: { value: '60' } })

    await waitFor(() => expect(heartbeatApi.updateInterval).toHaveBeenCalledWith('task-1', 60))
  })

  it('truncates long log summaries with a Show more toggle', async () => {
    const longSummary = 'x'.repeat(200)
    heartbeatApi.getLogs.mockResolvedValue([makeLog({ summary: longSummary })])

    render(<HeartbeatSection task={makeTask()} />)
    await screen.findByText('Off')

    openModal()

    await screen.findByText('Recent Checks')
    // LOG_SUMMARY_PREVIEW_LENGTH (160) chars + ellipsis
    expect(screen.getByText('x'.repeat(160) + '...')).toBeDefined()
    expect(screen.queryByText(longSummary)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByText(longSummary)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Show less' })).toBeDefined()
  })
})
