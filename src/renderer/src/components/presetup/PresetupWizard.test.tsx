import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PresetupWizard } from './PresetupWizard'
import type { PresetupTemplate } from '@/lib/presetup-api'

const mockTemplate: PresetupTemplate = {
  id: '1',
  slug: 'ai-accountant',
  name: 'AI Accountant',
  description: 'Accounting automation',
  version: '1.0.0',
  category: 'finance',
  tags: [],
  icon: 'Calculator',
  definition: {
    workflows: [],
    integrations: [],
    skills: [],
    questions: [
      {
        id: 'email_provider',
        question: 'Which email provider do you use?',
        hint: 'Select your primary email',
        options: [
          { value: 'gmail', label: 'Gmail' },
          { value: 'outlook', label: 'Outlook' }
        ]
      },
      {
        id: 'accounting_software',
        question: 'Which accounting software?',
        options: [
          {
            value: 'xero',
            label: 'Xero',
            integrations: [{ key: 'xero', name: 'Xero' }]
          },
          {
            value: 'quickbooks',
            label: 'QuickBooks',
            workflows: [{ slug: 'qb-sync', name: 'QB Sync' }]
          }
        ]
      }
    ]
  }
}

const noQuestionsTemplate: PresetupTemplate = {
  ...mockTemplate,
  definition: { ...mockTemplate.definition, questions: [] }
}

describe('PresetupWizard', () => {
  it('renders first question', () => {
    render(
      <PresetupWizard template={mockTemplate} onComplete={vi.fn()} onBack={vi.fn()} />
    )

    expect(screen.getAllByText('Which email provider do you use?').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Select your primary email').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByRole('button').some((b) => b.textContent?.includes('Gmail'))).toBe(true)
    expect(screen.getAllByRole('button').some((b) => b.textContent?.includes('Outlook'))).toBe(true)
  })

  it('shows progress indicator', () => {
    render(
      <PresetupWizard template={mockTemplate} onComplete={vi.fn()} onBack={vi.fn()} />
    )

    expect(screen.getAllByText(/Step 1 of 2/).length).toBeGreaterThanOrEqual(1)
  })

  it('disables Next button when no option selected', () => {
    render(
      <PresetupWizard template={mockTemplate} onComplete={vi.fn()} onBack={vi.fn()} />
    )

    // Find the Next button specifically (not Back)
    const buttons = screen.getAllByRole('button')
    const nextBtn = buttons.find((b) => b.textContent?.includes('Next'))
    expect(nextBtn).toBeDefined()
    expect(nextBtn).toBeDisabled()
  })

  it('enables Next button after selecting an option', () => {
    render(
      <PresetupWizard template={mockTemplate} onComplete={vi.fn()} onBack={vi.fn()} />
    )

    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.includes('Gmail'))!)
    const buttons = screen.getAllByRole('button')
    const nextBtn = buttons.find((b) => b.textContent?.includes('Next'))
    expect(nextBtn).not.toBeDisabled()
  })

  it('advances to next question on Next click', () => {
    render(
      <PresetupWizard template={mockTemplate} onComplete={vi.fn()} onBack={vi.fn()} />
    )

    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.includes('Gmail'))!)
    const buttons = screen.getAllByRole('button')
    const nextBtn = buttons.find((b) => b.textContent?.includes('Next'))!
    fireEvent.click(nextBtn)

    expect(screen.getAllByText(/Step 2 of 2/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Which accounting software?')).toBeInTheDocument()
  })

  it('shows "Set up" on last step', () => {
    render(
      <PresetupWizard template={mockTemplate} onComplete={vi.fn()} onBack={vi.fn()} />
    )

    // Go to step 2
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.includes('Gmail'))!)
    const buttons1 = screen.getAllByRole('button')
    fireEvent.click(buttons1.find((b) => b.textContent?.includes('Next'))!)

    // Last step should show "Set up"
    const buttons2 = screen.getAllByRole('button')
    expect(buttons2.some((b) => b.textContent?.includes('Set up'))).toBe(true)
  })

  it('calls onComplete with answers on final step', () => {
    const onComplete = vi.fn()
    const { container } = render(
      <PresetupWizard template={mockTemplate} onComplete={onComplete} onBack={vi.fn()} />
    )

    // Use container queries to get the actual live buttons
    const findBtn = (text: string) => {
      const buttons = Array.from(container.querySelectorAll('button'))
      return buttons.filter((b) => b.textContent?.includes(text)).pop()!
    }

    fireEvent.click(findBtn('Gmail'))
    fireEvent.click(findBtn('Next'))

    fireEvent.click(findBtn('Xero'))
    fireEvent.click(findBtn('Set up'))

    expect(onComplete).toHaveBeenCalledWith({
      email_provider: 'gmail',
      accounting_software: 'xero'
    })
  })

  it('calls onBack when Back clicked on first step', () => {
    const onBack = vi.fn()
    const { container } = render(
      <PresetupWizard template={mockTemplate} onComplete={vi.fn()} onBack={onBack} />
    )

    const backBtn = Array.from(container.querySelectorAll('button'))
      .filter((b) => b.textContent?.includes('Back'))
      .pop()!
    fireEvent.click(backBtn)
    expect(onBack).toHaveBeenCalled()
  })

  it('shows resource badges on options that add resources', () => {
    render(
      <PresetupWizard template={mockTemplate} onComplete={vi.fn()} onBack={vi.fn()} />
    )

    // Go to step 2 which has resource badges
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.includes('Gmail'))!)
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.includes('Next'))!)

    expect(screen.getAllByText(/\+1 integration/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/\+1 workflow/).length).toBeGreaterThanOrEqual(1)
  })

  it('shows install confirmation when no questions', () => {
    const onComplete = vi.fn()
    render(
      <PresetupWizard template={noQuestionsTemplate} onComplete={onComplete} onBack={vi.fn()} />
    )

    expect(screen.getAllByText(/Ready to install/).length).toBeGreaterThanOrEqual(1)

    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.includes('Install package'))!)
    expect(onComplete).toHaveBeenCalledWith({})
  })
})
