import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PresetupTemplateCard } from './PresetupTemplateCard'
import type { PresetupTemplate } from '@/lib/presetup-api'

const mockTemplate: PresetupTemplate = {
  id: '1',
  slug: 'ai-accountant',
  name: 'AI Accountant',
  description: 'Automate your accounting workflows',
  version: '1.0.0',
  category: 'finance',
  tags: ['accounting', 'automation', 'invoicing', 'reporting', 'extra-tag'],
  icon: 'Calculator',
  definition: {
    workflows: [
      { slug: 'invoice', name: 'Invoice' },
      { slug: 'reconcile', name: 'Reconcile' }
    ],
    integrations: [{ key: 'xero', name: 'Xero', required: true }],
    skills: [
      { name: 'data-extraction' },
      { name: 'categorization' },
      { name: 'reporting' }
    ],
    questions: []
  }
}

describe('PresetupTemplateCard', () => {
  it('renders template name and description', () => {
    render(<PresetupTemplateCard template={mockTemplate} onSelect={vi.fn()} />)

    expect(screen.getByText('AI Accountant')).toBeInTheDocument()
    expect(screen.getByText('Automate your accounting workflows')).toBeInTheDocument()
  })

  it('renders resource chips with correct counts', () => {
    render(<PresetupTemplateCard template={mockTemplate} onSelect={vi.fn()} />)

    expect(screen.getAllByText('2 workflows').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('1 integration').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('3 skills').length).toBeGreaterThanOrEqual(1)
  })

  it('shows max 4 tags and overflow count', () => {
    render(<PresetupTemplateCard template={mockTemplate} onSelect={vi.fn()} />)

    expect(screen.getAllByText('accounting').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('automation').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('+1 more').length).toBeGreaterThanOrEqual(1)
  })

  it('calls onSelect with template when Get started is clicked', () => {
    const onSelect = vi.fn()
    const { container } = render(<PresetupTemplateCard template={mockTemplate} onSelect={onSelect} />)

    const btn = Array.from(container.querySelectorAll('button'))
      .filter((b) => b.textContent?.includes('Get started'))
      .pop()!
    fireEvent.click(btn)
    expect(onSelect).toHaveBeenCalledWith(mockTemplate)
  })
})
