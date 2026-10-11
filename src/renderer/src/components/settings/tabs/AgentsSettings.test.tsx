import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Agent } from '@/types'
import type { AcpAgentInstanceView } from '@shared/acp-registry'

const getAll = vi.fn()
const testConnection = vi.fn()
const acpList = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  agentApi: {
    getAll: (...args: unknown[]) => getAll(...args),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  },
  // agent-store.ts also imports these at module scope (subscribes once on
  // store creation, not inside an action), so they need stubs even though
  // this test never exercises a live session.
  agentSessionApi: {},
  onAgentStatus: () => () => undefined,
  onAgentApproval: () => () => undefined,
  onTranscriptChanged: () => () => undefined,
  agentConfigApi: {
    testConnection: (...args: unknown[]) => testConnection(...args),
    getProviders: vi.fn()
  },
  acpInstanceApi: {
    list: (...args: unknown[]) => acpList(...args),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    install: vi.fn(),
    validateLocalCommand: vi.fn()
  },
  acpRegistryApi: {
    search: vi.fn().mockResolvedValue([])
  },
  // This page also renders HarnessInstancesSection, which loads this on mount.
  harnessInstanceApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    delete: vi.fn()
  }
}))

import { AgentsSettings } from './AgentsSettings'
import { useAgentStore } from '@/stores/agent-store'
import { useAcpInstanceStore } from '@/stores/acp-instance-store'

const grokInstance: AcpAgentInstanceView = {
  id: 'acp_grok',
  // Deliberately different from the agent's own name ('grok' below) so the
  // assertions can tell the instance's display name apart from the agent's.
  display_name: 'Grok Build',
  source: 'registry',
  registry_agent_id: 'grok-build',
  version: '1.0.0',
  distribution: 'auto',
  command_path: null,
  command_args: [],
  env: {},
  secret_ids: [],
  auth_method_id: null,
  custom_models: [],
  created_at: '2026-10-09T00:00:00.000Z'
}

function acpAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-grok',
    name: 'grok',
    // ACP agents keep OpenCode's unused default server_url — never cleared
    // by the form, since Server URL isn't shown for ACP.
    server_url: 'http://localhost:4096',
    is_default: false,
    config: { coding_agent: 'acp', acp_instance_id: 'acp_grok' },
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...overrides
  } as Agent
}

beforeEach(() => {
  cleanup()
  useAgentStore.setState({ agents: [] })
  useAcpInstanceStore.setState({ instances: [], loaded: false })
  getAll.mockReset().mockResolvedValue([acpAgent()])
  acpList.mockReset().mockResolvedValue([grokInstance])
  testConnection.mockReset().mockResolvedValue({ success: false, error: 'Backend returned no provider list' })
})

describe('AgentsSettings — ACP agents', () => {
  it('shows an ACP agent as connected without ever testing its (unused) server_url', async () => {
    // Regression: ACP agents run a locally-spawned process, never an HTTP
    // server. Treating config.server_url as a real endpoint to test hit
    // OpenCode's default ('http://localhost:4096') and failed with
    // "Backend returned no provider list" for every ACP agent.
    render(<AgentsSettings />)

    await screen.findByText('Ready')
    expect(testConnection).not.toHaveBeenCalled()
    expect(screen.queryByText('Backend returned no provider list')).toBeNull()
  })

  it("shows the ACP instance's display name instead of the raw server_url", async () => {
    render(<AgentsSettings />)
    await waitFor(() => expect(acpList).toHaveBeenCalled())

    // "Grok Build" legitimately appears twice: once in this agent's own row
    // (the fix) and once more in the separate "ACP agents" instances
    // section this page also renders — asserting it appears at all (rather
    // than exactly once) keeps this test from coupling to that section's
    // unrelated markup.
    await waitFor(() => expect(screen.getAllByText('Grok Build').length).toBeGreaterThan(0))
    expect(screen.queryByText('http://localhost:4096')).toBeNull()
  })
})
