import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { ContextWindowMeter } from './ContextWindowMeter'
import type { ContextUsageSnapshot } from '@shared/context-usage'

function makeUsage(over: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return {
    taskId: 'task-1',
    agentId: 'agent-1',
    codingAgent: 'claude-code',
    usedTokens: 100_000,
    maxTokens: 200_000,
    percent: 50,
    model: 'claude-sonnet',
    compacting: false,
    canCompact: false,
    updatedAt: '2026-10-05T10:00:00.000Z',
    ...over
  }
}

describe('ContextWindowMeter', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders nothing when usage is null', () => {
    const { container } = render(<ContextWindowMeter usage={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when usedTokens is null', () => {
    const { container } = render(<ContextWindowMeter usage={makeUsage({ usedTokens: null, percent: null })} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows used / max and the rounded percent', () => {
    const { getByText } = render(<ContextWindowMeter usage={makeUsage({ usedTokens: 150_000, percent: 75 })} />)
    expect(getByText('150k / 200k · 75%')).toBeTruthy()
  })

  it('shows used tokens only when the window size is unknown', () => {
    const { getByText, queryByRole } = render(
      <ContextWindowMeter usage={makeUsage({ usedTokens: 12_300, maxTokens: null, percent: null })} />
    )
    expect(getByText('12.3k used')).toBeTruthy()
    expect(queryByRole('meter')).toBeNull()
  })

  it.each([
    [50, 'text-muted-foreground', 'bg-primary'],
    [75, 'text-yellow-300', 'bg-yellow-400'],
    [95, 'text-red-400', 'bg-red-500']
  ])('colours the pill by level at %i%%', (percent, textClass, barClass) => {
    const { getByRole, getByLabelText } = render(<ContextWindowMeter usage={makeUsage({ percent })} />)
    expect(getByLabelText(/Context window:/).className).toContain(textClass)
    const bar = getByRole('meter').firstElementChild as HTMLElement
    expect(bar.className).toContain(barClass)
  })

  it('toggles the details panel on tap', () => {
    const { getByLabelText, queryByText, getByText } = render(<ContextWindowMeter usage={makeUsage()} />)
    expect(queryByText('claude-code')).toBeNull()

    fireEvent.click(getByLabelText(/Context window:/))
    expect(getByText('claude-code')).toBeTruthy()
    expect(getByText('claude-sonnet')).toBeTruthy()
  })

  it('shows the compact button only when canCompact and onCompact are both set', () => {
    const onCompact = vi.fn()
    const { getByLabelText, queryByText, rerender } = render(
      <ContextWindowMeter usage={makeUsage({ canCompact: false })} onCompact={onCompact} />
    )
    fireEvent.click(getByLabelText(/Context window:/))
    expect(queryByText('Compact context')).toBeNull()

    rerender(<ContextWindowMeter usage={makeUsage({ canCompact: true })} />)
    expect(queryByText('Compact context')).toBeNull()

    rerender(<ContextWindowMeter usage={makeUsage({ canCompact: true })} onCompact={onCompact} />)
    expect(queryByText('Compact context')).toBeTruthy()
  })

  it('calls onCompact when the compact button is tapped', () => {
    const onCompact = vi.fn()
    const { getByLabelText, getByText } = render(
      <ContextWindowMeter usage={makeUsage({ canCompact: true })} onCompact={onCompact} />
    )
    fireEvent.click(getByLabelText(/Context window:/))
    fireEvent.click(getByText('Compact context'))
    expect(onCompact).toHaveBeenCalledTimes(1)
  })

  it('shows Compacting… and disables the button while compacting', () => {
    const onCompact = vi.fn()
    const { getByLabelText, getByText } = render(
      <ContextWindowMeter usage={makeUsage({ canCompact: true, compacting: true })} onCompact={onCompact} />
    )
    fireEvent.click(getByLabelText(/Context window:/))
    const button = getByText('Compacting…').closest('button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onCompact).not.toHaveBeenCalled()
  })
})
