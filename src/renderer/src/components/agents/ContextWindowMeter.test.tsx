import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ContextWindowMeter } from './ContextWindowMeter'
import type { ContextUsageSnapshot } from '@shared/context-usage'

function snapshot(overrides: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  const usedTokens = overrides.usedTokens ?? 100_000
  const maxTokens = overrides.maxTokens ?? 200_000
  const percent = overrides.percent !== undefined ? overrides.percent : (maxTokens ? (usedTokens / maxTokens) * 100 : null)
  return {
    taskId: 'task-1',
    agentId: 'agent-1',
    codingAgent: 'claude-code',
    usedTokens,
    maxTokens,
    percent,
    model: 'claude-sonnet-5',
    compacting: false,
    canCompact: false,
    updatedAt: '2026-10-05T10:00:00.000Z',
    ...overrides
  }
}

function pill() {
  return screen.getByTestId('context-window-meter')
}

beforeEach(() => {
  cleanup()
})

describe('ContextWindowMeter', () => {
  it('renders nothing without a snapshot', () => {
    const { container } = render(<ContextWindowMeter usage={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when usedTokens is unknown', () => {
    const { container } = render(<ContextWindowMeter usage={snapshot({ usedTokens: null, percent: null })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows used / max and a rounded percentage', () => {
    render(<ContextWindowMeter usage={snapshot({ usedTokens: 150_000, maxTokens: 200_000 })} />)

    expect(pill()).toHaveTextContent('150k / 200k · 75%')
    expect(pill()).toHaveAttribute('aria-label', 'Context window: 150k of 200k tokens (75%)')
  })

  it('shows only the used tokens when the window size is unknown', () => {
    render(<ContextWindowMeter usage={snapshot({ usedTokens: 42_000, maxTokens: null, percent: null })} />)

    expect(pill()).toHaveTextContent('42k tokens')
    expect(pill()).not.toHaveTextContent('/')
    expect(pill()).toHaveAttribute('aria-label', 'Context window: 42k tokens')
    // No progress bar without a window size.
    expect(pill().querySelector('.bg-primary, .bg-yellow-400, .bg-red-500')).toBeNull()
  })

  it.each([
    [50, 'text-muted-foreground', 'bg-primary'],
    [75, 'text-yellow-500', 'bg-yellow-400'],
    [95, 'text-red-500', 'bg-red-500']
  ])('colours %i%% usage by level', (percent, textClass, barClass) => {
    render(<ContextWindowMeter usage={snapshot({ usedTokens: percent * 2_000, maxTokens: 200_000 })} />)

    expect(pill()).toHaveClass(textClass)
    expect(pill().querySelector(`.${barClass}`)).not.toBeNull()
  })

  it('clamps the bar width to 100% when over the window', () => {
    render(<ContextWindowMeter usage={snapshot({ usedTokens: 250_000, maxTokens: 200_000 })} />)

    const bar = pill().querySelector('span.block') as HTMLElement
    expect(bar.style.width).toBe('100%')
    expect(pill()).toHaveTextContent('125%')
  })

  it('shows a spinner and disables compaction while compacting', () => {
    const onCompact = vi.fn()
    render(<ContextWindowMeter usage={snapshot({ compacting: true, canCompact: true })} onCompact={onCompact} />)

    expect(pill()).toHaveTextContent('Compacting…')
    expect(pill()).toHaveAttribute('aria-label', expect.stringContaining('compacting'))
    expect(pill().querySelector('.animate-spin')).not.toBeNull()

    fireEvent.click(pill())
    const button = screen.getByRole('button', { name: 'Compacting…' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onCompact).not.toHaveBeenCalled()
  })

  it('disables compaction while the agent is mid-turn', () => {
    const onCompact = vi.fn()
    render(<ContextWindowMeter usage={snapshot({ canCompact: true })} onCompact={onCompact} busy />)

    fireEvent.click(pill())
    const button = screen.getByRole('button', { name: 'Compact context' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Available once the agent is idle')
    fireEvent.click(button)
    expect(onCompact).not.toHaveBeenCalled()
  })

  it('shows the compact action only when the harness can compact and a handler is given', () => {
    const onCompact = vi.fn()
    const { unmount } = render(<ContextWindowMeter usage={snapshot({ canCompact: true })} onCompact={onCompact} />)

    fireEvent.mouseEnter(pill())
    fireEvent.click(screen.getByRole('button', { name: 'Compact context' }))
    expect(onCompact).toHaveBeenCalledTimes(1)
    unmount()

    render(<ContextWindowMeter usage={snapshot({ canCompact: false })} onCompact={onCompact} />)
    fireEvent.mouseEnter(pill())
    expect(screen.queryByRole('button', { name: 'Compact context' })).toBeNull()
  })

  it('hides the compact action when no handler is given', () => {
    render(<ContextWindowMeter usage={snapshot({ canCompact: true })} />)

    fireEvent.mouseEnter(pill())
    expect(screen.queryByRole('button', { name: 'Compact context' })).toBeNull()
  })

  it('lists the details on hover', () => {
    render(<ContextWindowMeter usage={snapshot()} />)

    fireEvent.mouseEnter(pill())
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('100k tokens')
    expect(tooltip).toHaveTextContent('200k tokens')
    expect(tooltip).toHaveTextContent('50%')
    expect(tooltip).toHaveTextContent('claude-sonnet-5')
    expect(tooltip).toHaveTextContent('Claude Code')

    fireEvent.mouseLeave(pill())
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
