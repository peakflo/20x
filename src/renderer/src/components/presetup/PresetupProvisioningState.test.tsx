import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PresetupProvisioningState } from './PresetupProvisioningState'

describe('PresetupProvisioningState', () => {
  const defaultProps = {
    templateName: 'AI Accountant',
    onRetry: vi.fn(),
    onDismiss: vi.fn(),
    onComplete: vi.fn()
  }

  it('shows loading state during provisioning', () => {
    render(
      <PresetupProvisioningState
        {...defaultProps}
        phase="provisioning"
        error={null}
        provisionResult={null}
      />
    )

    expect(screen.getAllByText('Setting up AI Accountant').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/Creating workflows/).length).toBeGreaterThanOrEqual(1)
  })

  it('shows success state on complete', () => {
    render(
      <PresetupProvisioningState
        {...defaultProps}
        phase="complete"
        error={null}
        provisionResult={{
          status: 'completed',
          templateSlug: 'ai-accountant',
          templateVersion: '1.0.0',
          tenantId: 'tenant-1',
          steps: [
            { type: 'workflow', identifier: 'invoice', status: 'created' },
            { type: 'integration', identifier: 'xero', status: 'created' },
            { type: 'skill', identifier: 'data-extraction', status: 'created' },
            { type: 'skill', identifier: 'categorization', status: 'created' }
          ]
        }}
      />
    )

    expect(screen.getAllByText('AI Accountant is ready!').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/1 workflow/).length).toBeGreaterThanOrEqual(1)
  })

  it('calls onComplete when Done is clicked', () => {
    const onComplete = vi.fn()
    const { container } = render(
      <PresetupProvisioningState
        {...defaultProps}
        onComplete={onComplete}
        phase="complete"
        error={null}
        provisionResult={{
          status: 'completed',
          templateSlug: 'ai-accountant',
          templateVersion: '1.0.0',
          tenantId: 'tenant-1',
          steps: []
        }}
      />
    )

    const btns = Array.from(container.querySelectorAll('button'))
    fireEvent.click(btns.filter((b) => b.textContent?.includes('Done')).pop()!)
    expect(onComplete).toHaveBeenCalled()
  })

  it('shows error state with message', () => {
    render(
      <PresetupProvisioningState
        {...defaultProps}
        phase="error"
        error="Workflow clone failed"
        provisionResult={null}
      />
    )

    expect(screen.getAllByText('Setup failed').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Workflow clone failed').length).toBeGreaterThanOrEqual(1)
  })

  it('calls onRetry when Try again is clicked', () => {
    const onRetry = vi.fn()
    const { container } = render(
      <PresetupProvisioningState
        {...defaultProps}
        onRetry={onRetry}
        phase="error"
        error="Some error"
        provisionResult={null}
      />
    )

    const btns = Array.from(container.querySelectorAll('button'))
    fireEvent.click(btns.filter((b) => b.textContent?.includes('Try again')).pop()!)
    expect(onRetry).toHaveBeenCalled()
  })

  it('calls onDismiss when Skip for now is clicked', () => {
    const onDismiss = vi.fn()
    const { container } = render(
      <PresetupProvisioningState
        {...defaultProps}
        onDismiss={onDismiss}
        phase="error"
        error="Some error"
        provisionResult={null}
      />
    )

    const btns = Array.from(container.querySelectorAll('button'))
    fireEvent.click(btns.filter((b) => b.textContent?.includes('Skip for now')).pop()!)
    expect(onDismiss).toHaveBeenCalled()
  })
})
