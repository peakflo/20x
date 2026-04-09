import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { TaskProgressMessage, formatDuration } from './AgentTranscriptPanel'
import type { AgentMessage } from '@/stores/agent-store'

function makeTaskProgressMessage(overrides: Partial<AgentMessage['taskProgress']> = {}, msgOverrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'tp-1',
    role: 'assistant',
    content: 'Subagent task',
    timestamp: new Date('2026-04-09T00:00:00.000Z'),
    partType: 'task_progress',
    taskProgress: {
      taskId: 'task-abc',
      status: 'running',
      description: 'Research API endpoints',
      ...overrides,
    },
    ...msgOverrides,
  }
}

describe('formatDuration', () => {
  it('returns 0s for null/undefined/negative', () => {
    expect(formatDuration(null as unknown as number)).toBe('0s')
    expect(formatDuration(undefined as unknown as number)).toBe('0s')
    expect(formatDuration(-100)).toBe('0s')
  })

  it('formats seconds correctly', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(5000)).toBe('5s')
    expect(formatDuration(59000)).toBe('59s')
  })

  it('formats minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m 0s')
    expect(formatDuration(90000)).toBe('1m 30s')
    expect(formatDuration(125000)).toBe('2m 5s')
  })
})

describe('TaskProgressMessage', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('returns null for message without taskProgress', () => {
    const msg = makeTaskProgressMessage()
    delete (msg as unknown as Record<string, unknown>).taskProgress
    const { container } = render(<TaskProgressMessage message={msg} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders running state with spinner and progress bar', () => {
    const { getByTestId, container } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ status: 'running' })} />
    )
    const el = getByTestId('task-progress-message')
    expect(el.getAttribute('data-status')).toBe('running')
    expect(el.className).toContain('border-blue-500/30')
    // Progress bar (pulse animation)
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
    // Spinner
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('renders started state same as running', () => {
    const { getByTestId, container } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ status: 'started' })} />
    )
    expect(getByTestId('task-progress-message').getAttribute('data-status')).toBe('started')
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('renders completed state with green checkmark and no spinner', () => {
    const { getByTestId, container } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({
        status: 'completed',
        summary: 'All done',
        usage: { total_tokens: 1000, tool_uses: 5, duration_ms: 30000 }
      })} />
    )
    const el = getByTestId('task-progress-message')
    expect(el.getAttribute('data-status')).toBe('completed')
    expect(el.className).toContain('border-green-500/20')
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(container.querySelector('.animate-pulse')).toBeNull()
    // Green checkmark icon
    expect(container.querySelector('.text-green-400')).not.toBeNull()
  })

  it('renders failed state with error icon', () => {
    const { getByTestId } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ status: 'failed' })} />
    )
    const el = getByTestId('task-progress-message')
    expect(el.getAttribute('data-status')).toBe('failed')
    expect(el.className).toContain('border-red-500/30')
  })

  it('renders stopped state with yellow border', () => {
    const { getByTestId } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ status: 'stopped' })} />
    )
    const el = getByTestId('task-progress-message')
    expect(el.getAttribute('data-status')).toBe('stopped')
    expect(el.className).toContain('border-yellow-500/30')
  })

  it('displays description and falls back to default', () => {
    const { getByText, rerender } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ description: 'Custom description' })} />
    )
    expect(getByText('Custom description')).toBeDefined()

    rerender(
      <TaskProgressMessage message={makeTaskProgressMessage({ description: '' })} />
    )
    expect(getByText('Subagent task')).toBeDefined()
  })

  it('shows lastToolName only when running', () => {
    const { container, rerender } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ status: 'running', lastToolName: 'Bash' })} />
    )
    expect(container.textContent).toContain('Bash')

    rerender(
      <TaskProgressMessage message={makeTaskProgressMessage({ status: 'completed', lastToolName: 'Bash' })} />
    )
    expect(container.textContent).not.toContain('Bash')
  })

  it('shows tool count and elapsed time from usage', () => {
    const { container } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({
        status: 'completed',
        usage: { total_tokens: 5000, tool_uses: 12, duration_ms: 90000 }
      })} />
    )
    expect(container.textContent).toContain('12 tools')
    expect(container.textContent).toContain('1m 30s')
  })

  it('expands to show summary and usage details', () => {
    const { getByTestId, getByText, queryByText } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({
        status: 'completed',
        summary: 'Task finished successfully',
        usage: { total_tokens: 2000, tool_uses: 8, duration_ms: 45000 }
      })} />
    )

    // Summary should not be visible before expanding
    expect(queryByText('8 tool uses')).toBeNull()

    // Click to expand
    const button = getByTestId('task-progress-message').querySelector('button')!
    fireEvent.click(button)

    // Now summary and usage details are visible
    expect(getByText('8 tool uses')).toBeDefined()
    expect(getByText('2,000 tokens')).toBeDefined()
  })

  it('shows status dot and label in expanded view', () => {
    const { getByTestId, getByText } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ status: 'completed' })} />
    )
    const button = getByTestId('task-progress-message').querySelector('button')!
    fireEvent.click(button)
    expect(getByText('completed')).toBeDefined()
  })

  it('shows "No additional details" when no summary or usage', () => {
    const { getByTestId, getByText } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ status: 'completed' })} />
    )
    fireEvent.click(getByTestId('task-progress-message').querySelector('button')!)
    expect(getByText('No additional details available')).toBeDefined()
  })

  it('handles usage with null-ish fields gracefully', () => {
    const { getByTestId } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({
        status: 'completed',
        usage: { total_tokens: undefined as unknown as number, tool_uses: undefined as unknown as number, duration_ms: 0 }
      })} />
    )
    // Should not throw — renders without crashing
    const el = getByTestId('task-progress-message')
    expect(el.getAttribute('data-status')).toBe('completed')
    // Expand to check usage details render safely
    fireEvent.click(el.querySelector('button')!)
    expect(el.textContent).toContain('0 tool uses')
  })
})
