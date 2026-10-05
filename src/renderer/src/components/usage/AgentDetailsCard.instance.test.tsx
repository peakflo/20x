import { describe, it, expect, beforeEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ProviderUsageLimits } from '@shared/usage'
import type { Agent } from '@/types'
import { AgentDetailsCard } from './AgentHoverCard'
import { useUsageStore } from '@/stores/usage-store'
import { useHarnessInstanceStore } from '@/stores/harness-instance-store'

const limits = (instanceId: string, instanceLabel: string, usedPercent: number): ProviderUsageLimits => ({
  provider: 'codex',
  instanceId,
  instanceLabel,
  checkedAt: new Date().toISOString(),
  windows: [{ id: 'primary', kind: 'session', label: '5-hour', usedPercent, resetsAt: null }],
  unavailable: null
})

const agent = (harnessInstanceId?: string): Agent => ({
  id: 'agent-1',
  name: 'Reviewer',
  server_url: '',
  is_default: false,
  created_at: '',
  updated_at: '',
  config: { coding_agent: 'codex', ...(harnessInstanceId ? { harness_instance_id: harnessInstanceId } : {}) }
}) as unknown as Agent

beforeEach(() => {
  cleanup()
  useUsageStore.setState({
    limits: [limits('default:codex', 'Codex', 40), limits('hi_work', 'Codex · Work', 85)],
    loaded: true,
    refreshing: false,
    error: null
  })
  useHarnessInstanceStore.setState({
    instances: [{ id: 'hi_work', harness_type: 'codex', label: 'Work', home_path: '/x', created_at: '', shares_history: true }],
    loaded: true
  })
})

describe('AgentDetailsCard harness instance', () => {
  it('shows the account label and that account\'s plan limits', () => {
    render(<AgentDetailsCard agent={agent('hi_work')} />)
    expect(screen.getByText('Codex · Work')).toBeTruthy()
    expect(screen.getByText(/85% used/)).toBeTruthy()
    expect(screen.queryByText(/40% used/)).toBeNull()
  })

  it('uses the harness default account when the agent has no instance', () => {
    render(<AgentDetailsCard agent={agent()} />)
    expect(screen.getByText(/40% used/)).toBeTruthy()
    expect(screen.queryByText('Codex · Work')).toBeNull()
  })
})
