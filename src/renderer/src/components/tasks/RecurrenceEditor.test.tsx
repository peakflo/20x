import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { RecurrenceEditor } from './RecurrenceEditor'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RecurrenceEditor', () => {
  it('renders with recurring disabled when value is null', () => {
    const onChange = vi.fn()
    const { container } = render(<RecurrenceEditor value={null} onChange={onChange} />)

    const checkbox = container.querySelector('#enable-recurrence') as HTMLInputElement
    expect(checkbox).toBeTruthy()
    expect(checkbox.checked).toBe(false)
  })

  it('renders with recurring enabled when value is a cron string', () => {
    const onChange = vi.fn()
    const { container } = render(<RecurrenceEditor value="0 9 * * 1,2,3,4,5" onChange={onChange} />)

    const checkbox = container.querySelector('#enable-recurrence') as HTMLInputElement
    expect(checkbox).toBeTruthy()
    expect(checkbox.checked).toBe(true)
  })

  it('syncs enabled state when value prop changes from null to a cron string', async () => {
    const onChange = vi.fn()
    // Start with null (simulates TaskForm initial render before useEffect populates)
    const { container, rerender } = render(<RecurrenceEditor value={null} onChange={onChange} />)

    const checkbox = container.querySelector('#enable-recurrence') as HTMLInputElement
    expect(checkbox.checked).toBe(false)

    // Re-render with a cron value (simulates TaskForm useEffect setting recurrence_pattern)
    rerender(<RecurrenceEditor value="0 9 * * 1,2,3,4,5" onChange={onChange} />)

    await waitFor(() => {
      const updatedCheckbox = container.querySelector('#enable-recurrence') as HTMLInputElement
      expect(updatedCheckbox.checked).toBe(true)
    })
  })

  it('shows visual editor controls when enabled with a cron value', async () => {
    const onChange = vi.fn()
    const { container, rerender } = render(<RecurrenceEditor value={null} onChange={onChange} />)

    rerender(<RecurrenceEditor value="0 9 * * 1,2,3,4,5" onChange={onChange} />)

    await waitFor(() => {
      // Should show frequency and time controls
      const labels = Array.from(container.querySelectorAll('label')).map(l => l.textContent)
      expect(labels).toContain('Frequency')
      expect(labels).toContain('Time (UTC)')
    })
  })

  it('parses weekly cron correctly when value changes', async () => {
    const onChange = vi.fn()
    const { container, rerender } = render(<RecurrenceEditor value={null} onChange={onChange} />)

    rerender(<RecurrenceEditor value="30 14 * * 1,3,5" onChange={onChange} />)

    await waitFor(() => {
      // Should show Days of week label (weekly mode)
      const labels = Array.from(container.querySelectorAll('label')).map(l => l.textContent)
      expect(labels).toContain('Days of week')
    })
  })

  it('parses monthly cron correctly when value changes', async () => {
    const onChange = vi.fn()
    const { container, rerender } = render(<RecurrenceEditor value={null} onChange={onChange} />)

    rerender(<RecurrenceEditor value="0 10 15 * *" onChange={onChange} />)

    await waitFor(() => {
      const labels = Array.from(container.querySelectorAll('label')).map(l => l.textContent)
      expect(labels).toContain('Day of month')
    })
  })
})
