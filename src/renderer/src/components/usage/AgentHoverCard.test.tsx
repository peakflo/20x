import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentHoverCard, AgentDetailsCard } from './AgentHoverCard'
import { useUsageStore } from '@/stores/usage-store'
import { CodingAgentType, type Agent } from '@/types'
import type { ProviderUsageLimits } from '@shared/usage'

function agent(config: Agent['config']): Agent {
  return { id: 'a1', name: 'Backend Agent', server_url: '', config, is_default: false, created_at: '', updated_at: '' }
}

const claudeLimits: ProviderUsageLimits = {
  provider: 'claude-code',
  checkedAt: new Date().toISOString(),
  planType: 'max',
  windows: [
    { id: 'five_hour', kind: 'session', label: '5-hour', usedPercent: 44, resetsAt: null },
    { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 71, resetsAt: null }
  ],
  unavailable: null
}

beforeEach(() => {
  cleanup()
  vi.useRealTimers()
  useUsageStore.setState({ limits: [claudeLimits], loaded: true, refreshing: false, error: null })
})

describe('AgentDetailsCard', () => {
  it('shows short agent details and the harness plan limits', () => {
    render(<AgentDetailsCard agent={agent({
      coding_agent: CodingAgentType.CLAUDE_CODE, model: 'opus', reasoning_effort: 'high',
      permission_mode: 'allow', mcp_servers: ['m1', 'm2'], skill_ids: ['s1']
    })} />)
    const card = screen.getByTestId('agent-details-card')
    expect(card).toHaveTextContent('Backend Agent')
    expect(card).toHaveTextContent(/max/i)
    expect(card).toHaveTextContent('Claude Code')
    expect(card).toHaveTextContent('opus')
    expect(card).toHaveTextContent('high')
    expect(card).toHaveTextContent('Subscription')
    expect(card).toHaveTextContent('Auto-approve')
    expect(card).toHaveTextContent('2 MCP · 1 skill')
    expect(screen.getByRole('meter', { name: '5-hour: 44% used' })).toBeInTheDocument()
    expect(screen.getByRole('meter', { name: 'Weekly: 71% used' })).toBeInTheDocument()
  })

  it('shows long agent names and models in full (wrapped, never truncated)', () => {
    const longName = 'Backend Agent for the Accounts Payable reconciliation and vendor onboarding workflows'
    const longModel = 'anthropic/claude-opus-4-7-20260915-extended-thinking-preview'
    render(<AgentDetailsCard agent={{ ...agent({ coding_agent: CodingAgentType.OPENCODE, model: longModel }), name: longName }} />)
    const name = screen.getByText(longName)
    const model = screen.getByText(longModel)
    for (const el of [name, model]) {
      expect(el.className).not.toContain('truncate')
      expect(el.className).toContain('break-words')
    }
    expect(screen.getByTestId('agent-details-card').className).toContain('whitespace-normal')
  })

  it('explains when plan limits do not apply', () => {
    const { rerender } = render(<AgentDetailsCard agent={agent({ coding_agent: CodingAgentType.CLAUDE_CODE, auth_method: 'api_key' })} />)
    expect(screen.getByText('API key — plan limits do not apply.')).toBeInTheDocument()
    rerender(<AgentDetailsCard agent={agent({ coding_agent: CodingAgentType.PI })} />)
    expect(screen.getByText('This harness does not report plan limits.')).toBeInTheDocument()
    rerender(<AgentDetailsCard agent={agent({ coding_agent: CodingAgentType.CODEX })} />)
    expect(screen.getByText(/Plan limits appear once Codex runs/)).toBeInTheDocument()
  })
})

describe('AgentHoverCard', () => {
  it('opens after a short hover delay and closes on leave', () => {
    vi.useFakeTimers()
    render(
      <AgentHoverCard agent={agent({ coding_agent: CodingAgentType.CLAUDE_CODE })}>
        <button type="button">agent</button>
      </AgentHoverCard>
    )
    const trigger = screen.getByRole('button', { name: 'agent' })
    fireEvent.mouseEnter(trigger.parentElement!)
    expect(screen.queryByTestId('agent-details-card')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.getByTestId('agent-details-card')).toBeInTheDocument()
    fireEvent.mouseLeave(trigger.parentElement!)
    expect(screen.queryByTestId('agent-details-card')).not.toBeInTheDocument()
  })

  it('stays closed while disabled or without an agent', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <AgentHoverCard agent={agent({ coding_agent: CodingAgentType.CODEX })} disabled>
        <button type="button">agent</button>
      </AgentHoverCard>
    )
    fireEvent.mouseEnter(screen.getByRole('button').parentElement!)
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.queryByTestId('agent-details-card')).not.toBeInTheDocument()

    rerender(<AgentHoverCard agent={null}><button type="button">agent</button></AgentHoverCard>)
    fireEvent.mouseEnter(screen.getByRole('button').parentElement!)
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.queryByTestId('agent-details-card')).not.toBeInTheDocument()
  })
})
