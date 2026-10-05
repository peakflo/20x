import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentForm } from './AgentForm'
import { CodingAgentType, type Agent, type CreateAgentDTO, type UpdateAgentDTO } from '@/types'

function agent(config: Agent['config']): Agent {
  return { id: 'a1', name: 'Backend Agent', server_url: 'http://localhost:4096', config, is_default: false, created_at: '', updated_at: '' }
}

async function renderForm(existing?: Agent) {
  const onSubmit = vi.fn<(data: CreateAgentDTO | UpdateAgentDTO) => void>()
  // Mount effects fetch MCP servers, skills and env flags; let them settle inside act.
  await act(async () => {
    render(<AgentForm agent={existing} onSubmit={onSubmit} onCancel={vi.fn()} />)
  })
  return onSubmit
}

function savedConfig(onSubmit: ReturnType<typeof vi.fn>) {
  expect(onSubmit).toHaveBeenCalledTimes(1)
  return (onSubmit.mock.calls[0][0] as { config: Record<string, unknown> }).config
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AgentForm auto-compact', () => {
  it('is off by default for Claude Code and saves null', async () => {
    const onSubmit = await renderForm(agent({ coding_agent: CodingAgentType.CLAUDE_CODE, model: 'claude-sonnet-5' }))

    const toggle = screen.getByRole('switch')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByLabelText('Context window for auto-compact')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(savedConfig(onSubmit).auto_compact_tokens).toBeNull()
  })

  it('saves the normalised threshold when enabled, capped at the model window', async () => {
    const onSubmit = await renderForm(agent({ coding_agent: CodingAgentType.CLAUDE_CODE, model: 'claude-sonnet-5' }))

    fireEvent.click(screen.getByRole('switch'))
    const input = screen.getByLabelText('Context window for auto-compact') as HTMLInputElement
    expect(input).toHaveAttribute('min', '100000')
    expect(input).toHaveAttribute('max', '200000')
    expect(input).toHaveAttribute('step', '10000')
    expect(screen.getByText(/Capped at the model's window: 200k/)).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '150000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(savedConfig(onSubmit).auto_compact_tokens).toBe(150_000)
  })

  it('allows up to 1M for [1m] models', async () => {
    const onSubmit = await renderForm(agent({ coding_agent: CodingAgentType.CLAUDE_CODE, model: 'claude-opus-4-7[1m]' }))

    fireEvent.click(screen.getByRole('switch'))
    const input = screen.getByLabelText('Context window for auto-compact') as HTMLInputElement
    expect(input).toHaveAttribute('max', '1000000')
    fireEvent.change(input, { target: { value: '340000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(savedConfig(onSubmit).auto_compact_tokens).toBe(340_000)
  })

  it('restores an existing threshold as enabled', async () => {
    await renderForm(agent({ coding_agent: CodingAgentType.CLAUDE_CODE, auto_compact_tokens: 250_000 }))

    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Context window for auto-compact')).toHaveValue(250_000)
  })

  it('does not add the key for other coding agents', async () => {
    const onSubmit = await renderForm(agent({ coding_agent: CodingAgentType.CODEX, model: 'gpt-5' }))

    expect(screen.queryByRole('switch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(savedConfig(onSubmit).auto_compact_tokens).toBeUndefined()
  })
})
