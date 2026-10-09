import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/lib/ipc-client', () => ({
  agentConfigApi: { getProviders: vi.fn(async () => ({ providers: [], default: {} })) }
}))
vi.mock('@/stores/harness-instance-store', () => {
  const state = { instances: [], load: async () => undefined }
  return { useHarnessInstanceStore: (sel: (s: typeof state) => unknown) => sel(state) }
})
vi.mock('@/stores/mcp-store', () => ({ useMcpStore: () => ({ servers: [], fetchServers: () => undefined }) }))
vi.mock('@/stores/skill-store', () => ({ useSkillStore: () => ({ skills: [], fetchSkills: () => undefined }) }))
vi.mock('@/components/skills/SkillSelectorDialog', () => ({ SkillSelectorDialog: () => null }))
vi.mock('@/components/secrets/SecretSelector', () => ({ SecretSelector: () => null }))

import { AgentForm } from './AgentForm'

function selectHarness(value: string): void {
  fireEvent.change(screen.getByLabelText('Coding Agent'), { target: { value } })
}

beforeEach(() => cleanup())

describe('AgentForm server URL', () => {
  it('asks for the coding agent right after the name, with no server URL until OpenCode is chosen', () => {
    render(<AgentForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    const name = screen.getByLabelText('Name')
    const harness = screen.getByLabelText('Coding Agent')
    expect(name.compareDocumentPosition(harness) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByLabelText('Server URL')).toBeNull()
  })

  it('shows the server URL below the coding agent only for OpenCode', () => {
    render(<AgentForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    selectHarness('opencode')
    const url = screen.getByLabelText('Server URL')
    expect(screen.getByLabelText('Coding Agent').compareDocumentPosition(url) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    for (const harness of ['claude-code', 'codex', 'cursor', 'pi']) {
      selectHarness(harness)
      expect(screen.queryByLabelText('Server URL')).toBeNull()
    }
  })

  it('no longer shows the "runs locally via CLI" notes', () => {
    render(<AgentForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    selectHarness('claude-code')
    expect(screen.queryByText(/doesn't require a server URL/)).toBeNull()
  })
})
