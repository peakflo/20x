import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SearchableSelect } from './SearchableSelect'

const OPTIONS = [
  { value: 'anthropic/claude-sonnet-4', label: 'Anthropic - Claude Sonnet 4' },
  { value: 'openai/gpt-5', label: 'OpenAI - GPT-5' },
  { value: 'google/gemini-3.5-flash-lite', label: 'Google - Gemini 3.5 Flash Lite' }
]

describe('SearchableSelect', () => {
  afterEach(() => {
    cleanup()
  })

  it('filters options by label and value', () => {
    const onChange = vi.fn()

    render(
      <SearchableSelect
        options={OPTIONS}
        value=""
        onChange={onChange}
        placeholder="Select a model..."
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /select a model/i }))
    expect(screen.getAllByRole('option')).toHaveLength(3)

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'sonnet' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Claude Sonnet 4/i })).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'gemini-3.5' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Gemini 3.5 Flash Lite/i })).toBeInTheDocument()
  })

  it('calls onChange and closes when an option is selected', () => {
    const onChange = vi.fn()

    render(
      <SearchableSelect
        options={OPTIONS}
        value=""
        onChange={onChange}
        placeholder="Select a model..."
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /select a model/i }))
    fireEvent.click(screen.getByRole('option', { name: /GPT-5/i }))

    expect(onChange).toHaveBeenCalledWith('openai/gpt-5')
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })
})
