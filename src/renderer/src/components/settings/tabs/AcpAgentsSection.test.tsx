import { describe, it, expect, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AcpAgentInstanceView, AcpRegistrySearchResult } from '@shared/acp-registry'

const list = vi.fn()
const create = vi.fn()
const remove = vi.fn()
const install = vi.fn()
const validateLocalCommand = vi.fn()
const search = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  acpInstanceApi: {
    list: (...args: unknown[]) => list(...args),
    create: (...args: unknown[]) => create(...args),
    update: vi.fn(),
    delete: (...args: unknown[]) => remove(...args),
    install: (...args: unknown[]) => install(...args),
    validateLocalCommand: (...args: unknown[]) => validateLocalCommand(...args)
  },
  acpRegistryApi: {
    search: (...args: unknown[]) => search(...args)
  }
}))

import { AcpAgentsSection } from './AcpAgentsSection'
import { useAcpInstanceStore } from '@/stores/acp-instance-store'

const devin: AcpAgentInstanceView = {
  id: 'acp_devin',
  display_name: 'Devin',
  source: 'registry',
  registry_agent_id: 'devin',
  version: '1.2.3',
  distribution: 'auto',
  command_path: null,
  command_args: [],
  env: {},
  secret_ids: [],
  auth_method_id: null,
  custom_models: [],
  created_at: '2026-10-09T00:00:00.000Z'
}

const localAgent: AcpAgentInstanceView = {
  id: 'acp_local',
  display_name: 'My Local Agent',
  source: 'local',
  registry_agent_id: null,
  version: null,
  distribution: 'auto',
  command_path: '/usr/local/bin/my-agent',
  command_args: ['--acp'],
  env: { FOO: 'bar' },
  secret_ids: [],
  auth_method_id: null,
  custom_models: [],
  created_at: '2026-10-09T00:00:00.000Z'
}

const devinSearchResult: AcpRegistrySearchResult = {
  id: 'devin',
  name: 'Devin',
  description: 'Autonomous software engineer',
  version: '1.2.3',
  license: 'MIT',
  licenseUrl: 'https://example.com/license',
  repository: 'https://github.com/example/devin-acp',
  website: null,
  icon: null,
  installableHere: true
}

beforeEach(() => {
  cleanup()
  useAcpInstanceStore.setState({ instances: [], loaded: false })
  list.mockReset().mockResolvedValue([devin, localAgent])
  create.mockReset().mockResolvedValue({ ...localAgent, id: 'acp_new' })
  remove.mockReset().mockResolvedValue(true)
  install.mockReset().mockResolvedValue({ ok: true, command: '/resolved/devin' })
  validateLocalCommand.mockReset().mockResolvedValue({ ok: true })
  search.mockReset().mockResolvedValue([devinSearchResult])
})

describe('AcpAgentsSection', () => {
  it('lists configured instances with their source badge', async () => {
    render(<AcpAgentsSection />)

    const registryRow = await screen.findByTestId('acp-instance-acp_devin')
    expect(within(registryRow).getByText('Devin')).toBeTruthy()
    expect(within(registryRow).getByText('Registry')).toBeTruthy()

    const localRow = screen.getByTestId('acp-instance-acp_local')
    expect(within(localRow).getByText('My Local Agent')).toBeTruthy()
    expect(within(localRow).getByText('Local command')).toBeTruthy()
    expect(within(localRow).getByText('/usr/local/bin/my-agent --acp')).toBeTruthy()
  })

  it('removes an instance and reloads the list', async () => {
    render(<AcpAgentsSection />)
    await screen.findByTestId('acp-instance-acp_devin')

    fireEvent.click(screen.getByLabelText('Remove Devin'))

    await waitFor(() => expect(remove).toHaveBeenCalledWith('acp_devin'))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('opens the add dialog with both tabs available', async () => {
    render(<AcpAgentsSection />)
    await screen.findByTestId('acp-instance-acp_devin')

    fireEvent.click(screen.getByRole('button', { name: /add acp agent/i }))

    expect(screen.getByRole('tab', { name: 'Registry search' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Local ACP command' })).toBeTruthy()
  })

  it('searches the registry (debounced) and installs + adds a selected result', async () => {
    render(<AcpAgentsSection />)
    await screen.findByTestId('acp-instance-acp_devin')
    fireEvent.click(screen.getByRole('button', { name: /add acp agent/i }))

    fireEvent.change(screen.getByLabelText('Search the ACP agent registry'), { target: { value: 'devin' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith('devin'), { timeout: 1000 })

    const result = await screen.findByTestId('acp-registry-result-devin')
    fireEvent.click(within(result).getByRole('button', { name: 'Add' }))
    fireEvent.click(within(result).getByRole('button', { name: /install & add/i }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        display_name: 'Devin',
        source: 'registry',
        registry_agent_id: 'devin',
        version: '1.2.3',
        distribution: 'auto'
      })
    )
    await waitFor(() => expect(install).toHaveBeenCalled())
  })

  it('validates and adds a local command agent', async () => {
    render(<AcpAgentsSection />)
    await screen.findByTestId('acp-instance-acp_devin')
    fireEvent.click(screen.getByRole('button', { name: /add acp agent/i }))
    fireEvent.click(screen.getByRole('tab', { name: 'Local ACP command' }))

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'My New Agent' } })
    fireEvent.change(screen.getByLabelText('Executable'), { target: { value: '/opt/agent/bin/agent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    await waitFor(() => expect(validateLocalCommand).toHaveBeenCalledWith('/opt/agent/bin/agent'))

    fireEvent.click(screen.getByRole('button', { name: /add local acp agent/i }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        display_name: 'My New Agent',
        source: 'local',
        command_path: '/opt/agent/bin/agent',
        command_args: [],
        env: {}
      })
    )
  })
})
