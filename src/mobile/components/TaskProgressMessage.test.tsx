import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { TaskProgressMessage, formatDuration } from './MessageBubble'
import type { AgentMessage } from '../stores/agent-store'

function makeTaskProgressMessage(overrides: Partial<AgentMessage['taskProgress']> = {}): AgentMessage {
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
  }
}

describe('formatDuration (mobile)', () => {
  it('handles edge cases', () => {
    expect(formatDuration(null as unknown as number)).toBe('0s')
    expect(formatDuration(-1)).toBe('0s')
    expect(formatDuration(0)).toBe('0s')
  })

  it('formats durations correctly', () => {
    expect(formatDuration(5000)).toBe('5s')
    expect(formatDuration(90000)).toBe('1m 30s')
  })
})

describe('TaskProgressMessage (mobile)', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('returns null when taskProgress is missing', () => {
    const msg = makeTaskProgressMessage()
    delete (msg as unknown as Record<string, unknown>).taskProgress
    const { container } = render(<TaskProgressMessage message={msg} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders running state with spinner and progress bar', () => {
    const { getByTestId, container } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ status: 'running' })} />
    )
    expect(getByTestId('task-progress-message').getAttribute('data-status')).toBe('running')
    expect(container.querySelector('.animate-spin')).not.toBeNull()
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
  })

  it('renders completed state with green checkmark, no spinner or progress bar', () => {
    const { getByTestId, container } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({
        status: 'completed',
        usage: { total_tokens: 500, tool_uses: 3, duration_ms: 10000 }
      })} />
    )
    expect(getByTestId('task-progress-message').getAttribute('data-status')).toBe('completed')
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(container.querySelector('.animate-pulse')).toBeNull()
    expect(container.querySelector('.text-green-400')).not.toBeNull()
  })

  it('renders failed state with red border', () => {
    const { getByTestId } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ status: 'failed' })} />
    )
    const el = getByTestId('task-progress-message')
    expect(el.className).toContain('border-red-500/30')
  })

  it('renders stopped state with yellow border', () => {
    const { getByTestId } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ status: 'stopped' })} />
    )
    expect(getByTestId('task-progress-message').className).toContain('border-yellow-500/30')
  })

  it('shows description and fallback', () => {
    const { getByText, rerender } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ description: 'Fixing bug' })} />
    )
    expect(getByText('Fixing bug')).toBeDefined()

    rerender(<TaskProgressMessage message={makeTaskProgressMessage({ description: '' })} />)
    expect(getByText('Subagent task')).toBeDefined()
  })

  it('shows lastToolName only when running', () => {
    const { container, rerender } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({ status: 'running', lastToolName: 'Edit' })} />
    )
    expect(container.textContent).toContain('Edit')

    rerender(<TaskProgressMessage message={makeTaskProgressMessage({ status: 'completed', lastToolName: 'Edit' })} />)
    expect(container.textContent).not.toContain('Edit')
  })

  it('expands to show status label, summary and usage', () => {
    const { getByTestId, getByText, queryByText } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({
        status: 'completed',
        summary: 'All files updated',
        usage: { total_tokens: 3000, tool_uses: 10, duration_ms: 60000 }
      })} />
    )

    expect(queryByText('10 tool uses')).toBeNull()

    fireEvent.click(getByTestId('task-progress-message').querySelector('button')!)

    expect(getByText('completed')).toBeDefined()
    expect(getByText('10 tool uses')).toBeDefined()
    expect(getByText('3,000 tokens')).toBeDefined()
    // '1m 0s' may appear in both header and expanded usage — just check it exists
    const el = getByTestId('task-progress-message')
    expect(el.textContent).toContain('1m 0s')
  })

  it('handles null-ish usage fields without throwing', () => {
    const { getByTestId } = render(
      <TaskProgressMessage message={makeTaskProgressMessage({
        status: 'completed',
        usage: { total_tokens: undefined as unknown as number, tool_uses: undefined as unknown as number, duration_ms: 0 }
      })} />
    )
    // Should not throw — renders without crashing
    const el = getByTestId('task-progress-message')
    expect(el.getAttribute('data-status')).toBe('completed')
    fireEvent.click(el.querySelector('button')!)
    expect(el.textContent).toContain('0 tool uses')
  })
})
