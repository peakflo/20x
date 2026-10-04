import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AiUsageRing } from './AiUsageRing'

afterEach(cleanup)

describe('AiUsageRing', () => {
  it('renders nothing without an active subscription', () => {
    const { container } = render(<AiUsageRing usage={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the percent label when usage is provided', () => {
    render(<AiUsageRing usage={{ percent: 42, used: 4, limit: 10, resetAt: null }} />)
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('hides the detail popover until hovered, then shows period info without dollar amounts', () => {
    render(
      <AiUsageRing
        usage={{ percent: 87, used: 87, limit: 100, resetAt: '2026-10-15T00:00:00.000Z' }}
      />
    )
    expect(screen.queryByTestId('ai-usage-tooltip')).not.toBeInTheDocument()

    fireEvent.mouseEnter(screen.getByTestId('ai-usage-ring'))
    const tooltip = screen.getByTestId('ai-usage-tooltip')
    expect(tooltip).toBeInTheDocument()
    expect(tooltip.textContent).toContain('87% used')
    expect(tooltip.textContent).toContain('Resets')
    expect(tooltip.textContent).not.toMatch(/\$|USD/)

    fireEvent.mouseLeave(screen.getByTestId('ai-usage-ring'))
    expect(screen.queryByTestId('ai-usage-tooltip')).not.toBeInTheDocument()
  })

  it('uses the shared colors: yellow above 75%, red above 90%', () => {
    const { rerender } = render(<AiUsageRing usage={{ percent: 60, used: 6, limit: 10, resetAt: null }} />)
    expect(screen.getByTestId('ai-usage-ring').querySelector('.bg-primary')).not.toBeNull()
    rerender(<AiUsageRing usage={{ percent: 80, used: 8, limit: 10, resetAt: null }} />)
    expect(screen.getByTestId('ai-usage-ring').querySelector('.bg-yellow-400')).not.toBeNull()
    rerender(<AiUsageRing usage={{ percent: 92, used: 9, limit: 10, resetAt: null }} />)
    expect(screen.getByTestId('ai-usage-ring').querySelector('.bg-red-500')).not.toBeNull()
  })

  it('also shows the popover on keyboard focus', () => {
    render(<AiUsageRing usage={{ percent: 97, used: 97, limit: 100, resetAt: null }} />)
    fireEvent.focus(screen.getByRole('button', { name: /Peakflo AI/ }))
    expect(screen.getByTestId('ai-usage-tooltip')).toBeInTheDocument()
    fireEvent.blur(screen.getByRole('button', { name: /Peakflo AI/ }))
    expect(screen.queryByTestId('ai-usage-tooltip')).not.toBeInTheDocument()
  })
})
