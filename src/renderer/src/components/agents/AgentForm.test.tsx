import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CodingAgentType } from '@/types'
import type { Agent } from '@/types'

// AgentForm reads these stores both with and without a selector. Mock them
// selector-aware: a whole-object return would break the moment the component
// picks a single field.
function mockSelectorStore(key: string, state: Record<string, unknown>) {
  const useStore = (selector?: (s: Record<string, unknown>) => unknown) =>
    selector ? selector(state) : state
  useStore.getState = () => state
  return { [key]: useStore }
}

vi.mock('@/stores/harness-instance-store', () =>
  mockSelectorStore('useHarnessInstanceStore', { instances: [], load: vi.fn() })
)
vi.mock('@/stores/acp-instance-store', () =>
  mockSelectorStore('useAcpInstanceStore', { instances: [], load: vi.fn() })
)
vi.mock('@/stores/mcp-store', () =>
  mockSelectorStore('useMcpStore', { servers: [], fetchServers: vi.fn() })
)
vi.mock('@/stores/skill-store', () =>
  mockSelectorStore('useSkillStore', { skills: [], fetchSkills: vi.fn() })
)
vi.mock('@/stores/secret-store', () =>
  mockSelectorStore('useSecretStore', { secrets: [], fetchSecrets: vi.fn() })
)
vi.mock('@/lib/ipc-client', () => ({
  agentConfigApi: { getProviders: vi.fn().mockResolvedValue({ providers: [] }) }
}))
vi.mock('@/components/skills/SkillSelectorDialog', () => ({
  SkillSelectorDialog: () => null
}))

import { AgentForm } from './AgentForm'

function makeAgent(config: Partial<Agent['config']> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Existing Agent',
    server_url: 'http://localhost:4096',
    is_default: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    config
  } as Agent
}

function getPermissionSelect(): HTMLSelectElement {
  return screen.getByLabelText('Permissions') as HTMLSelectElement
}

// The Permissions section only renders once a coding agent is picked.
function selectCodingAgent(value = 'opencode'): void {
  fireEvent.change(screen.getByLabelText('Coding Agent'), { target: { value } })
}

beforeEach(() => {
  cleanup()
})

afterEach(() => {
  cleanup()
})

describe('AgentForm — permission_mode default', () => {
  it('pre-selects "Allow automatically" for a new agent', () => {
    render(<AgentForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    selectCodingAgent()

    expect(getPermissionSelect()).toHaveValue('allow')
  })

  it('pre-fills the stored permission_mode when editing an agent', () => {
    render(
      <AgentForm
        agent={makeAgent({ coding_agent: CodingAgentType.OPENCODE, permission_mode: 'ask' })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(getPermissionSelect()).toHaveValue('ask')
  })

  it('falls back to allow when an edited agent has no permission_mode key', () => {
    // Agents stored before the default changed carry no key at all.
    render(
      <AgentForm
        agent={makeAgent({ coding_agent: CodingAgentType.OPENCODE })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(getPermissionSelect()).toHaveValue('allow')
  })

  it('still lets the user pick "Ask" and submits the chosen mode', async () => {
    const onSubmit = vi.fn()
    render(<AgentForm onSubmit={onSubmit} onCancel={vi.fn()} />)
    selectCodingAgent()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My Agent' } })
    fireEvent.change(getPermissionSelect(), { target: { value: 'ask' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1)
    })
    expect(onSubmit.mock.calls[0][0].config.permission_mode).toBe('ask')
  })
})
