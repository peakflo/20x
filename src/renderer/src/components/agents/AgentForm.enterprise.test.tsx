import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Agent } from '@/types'

function sel(key: string, state: Record<string, unknown>) {
  const useStore = (selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(state) : state)
  useStore.getState = () => state
  return { [key]: useStore }
}

const auth = vi.hoisted(() => ({ isAuthenticated: true }))
const api = vi.hoisted(() => ({ getAgentInfo: vi.fn(), listRunners: vi.fn() }))
const synced = vi.hoisted(() => ({
  agents: [{
    id: 'local-1', name: '[Workflo] Reviewer', server_url: '', is_default: false, created_at: '', updated_at: '',
    config: { coding_agent: 'enterprise-runner', enterprise_agent_id: 'srv-1' }
  }]
}))

vi.mock('@/stores/harness-instance-store', () => sel('useHarnessInstanceStore', { instances: [], load: vi.fn() }))
vi.mock('@/stores/acp-instance-store', () => sel('useAcpInstanceStore', { instances: [], load: vi.fn() }))
vi.mock('@/stores/mcp-store', () => sel('useMcpStore', { servers: [], fetchServers: vi.fn() }))
vi.mock('@/stores/skill-store', () => sel('useSkillStore', { skills: [], fetchSkills: vi.fn() }))
vi.mock('@/stores/secret-store', () => sel('useSecretStore', { secrets: [], fetchSecrets: vi.fn() }))
vi.mock('@/stores/agent-store', () => sel('useAgentStore', synced))
vi.mock('@/stores/enterprise-store', () => ({
  useEnterpriseStore: (s: (x: { isAuthenticated: boolean }) => unknown) => s(auth)
}))
vi.mock('@/lib/ipc-client', () => ({
  agentConfigApi: { getProviders: vi.fn().mockResolvedValue({ providers: [] }) },
  enterpriseRunnersApi: api
}))
vi.mock('@/components/settings/tabs/CursorSettingsCard', () => ({ CursorSettingsCard: () => null }))
vi.mock('@/components/skills/SkillSelectorDialog', () => ({ SkillSelectorDialog: () => null }))

import { AgentForm } from './AgentForm'

describe('AgentForm — Enterprise runner group', () => {
  beforeEach(() => {
    auth.isAuthenticated = true
    api.getAgentInfo.mockResolvedValue({ agentId: 'local-1', enterpriseAgentId: 'srv-1', backend: 'claude-code', permissionLimit: 'accept-edits', runnerPin: null, usable: true })
    api.listRunners.mockResolvedValue({ ok: true, fetchedAt: 0, runners: [
      { id: 'r1', name: 'studio-mac', kind: 'mine', status: 'online', harnesses: [{ name: 'claude-code' }], activeSessionCount: 0, lastSeenAt: null, version: null, selectable: true, serverReason: null },
      { id: 'r2', name: 'old-laptop', kind: 'mine', status: 'offline', harnesses: [{ name: 'claude-code' }], activeSessionCount: 0, lastSeenAt: null, version: null, selectable: false, serverReason: null }
    ] })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { env: { get: vi.fn().mockResolvedValue(undefined) } }
  })
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('lists synced [Workflo] agents under an Enterprise runner group when signed in', () => {
    render(<AgentForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    const group = document.querySelector('optgroup[label="Enterprise runner"]')
    expect(group).toBeTruthy()
    expect(group?.textContent).toContain('[Workflo] Reviewer')
  })

  it('hides the group when signed out', () => {
    auth.isAuthenticated = false
    render(<AgentForm onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(document.querySelector('optgroup[label="Enterprise runner"]')).toBeNull()
  })

  it('disables permission modes above the Spaces limit with a tooltip and cannot select them', async () => {
    const onSubmit = vi.fn()
    render(<AgentForm onSubmit={onSubmit} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Coding Agent'), { target: { value: 'enterprise-runner:srv-1' } })
    await waitFor(() => expect((screen.getByLabelText('Bypass') as HTMLInputElement).disabled).toBe(true))
    expect(screen.getByTestId('runner-mode-bypass').getAttribute('title')).toBe('Limited by your Spaces permissions')
    expect((screen.getByLabelText('Accept edits') as HTMLInputElement).disabled).toBe(false)
    fireEvent.click(screen.getByLabelText('Bypass'))
    expect((screen.getByLabelText('Bypass') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByLabelText('Ask for everything'))
    fireEvent.change(screen.getByLabelText('Runner pin (optional)'), { target: { value: 'r1' } })
    fireEvent.click(screen.getByText('Create'))
    const cfg = onSubmit.mock.calls[0][0].config
    expect(cfg).toMatchObject({ coding_agent: 'enterprise-runner', enterprise_agent_id: 'srv-1', runner_id: 'r1', runner_permission_mode: 'ask' })
    expect(cfg.api_keys.openai).toBeUndefined()
  })

  it('hides local-only fields and notes an offline pinned runner', async () => {
    const existing = { ...synced.agents[0], config: { ...synced.agents[0].config, runner_id: 'r2' } } as unknown as Agent
    render(<AgentForm agent={existing} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByTestId('runner-pin-offline')).toBeTruthy()
    expect(screen.queryByText('MCP Servers')).toBeNull()
    expect(screen.queryByLabelText('System Prompt')).toBeNull()
    expect(screen.queryByText('Secrets')).toBeNull()
    expect(screen.getByText(/Edit in Spaces/)).toBeTruthy()
  })
})
