import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MachineRow, MachinesResult } from '@shared/enterprise-runners'

const list = vi.fn()
const remove = vi.fn()
const rename = vi.fn()
const update = vi.fn()

vi.mock('@/lib/ipc-client', () => ({
  enterpriseRunnersApi: {
    list: (...a: unknown[]) => list(...a),
    remove: (...a: unknown[]) => remove(...a),
    rename: (...a: unknown[]) => rename(...a),
    update: (...a: unknown[]) => update(...a)
  }
}))

import { MachinesSettings } from './MachinesSettings'
import { useEnterpriseStore } from '@/stores/enterprise-store'
import { useMachinesStore } from '@/stores/machines-store'
import { useConnectComputerStore } from '@/stores/connect-computer-store'

const machine = (patch: Partial<MachineRow> & { id: string; name: string }): MachineRow => ({
  scope: 'mine',
  platform: 'Linux · x64',
  thisComputer: false,
  status: 'busy',
  lastSeenAt: new Date().toISOString(),
  version: '1.7.0',
  versionState: { kind: 'update_available', target: '1.8.2', reason: null, updating: false },
  harnesses: ['claude-code'],
  pinnedAgents: [{ id: 'a', name: 'Backend dev', backend: 'claude-code' }],
  ownerName: null,
  activeSessions: 2,
  maxSessions: 4,
  canManage: true,
  unavailableReason: null,
  serviceInstances: ['claude-code'],
  update: { supported: true, selfUpdate: true, available: true, targetVersion: '1.8.2', state: null, reason: null, nowRequested: false },
  ...patch
})

const ok = (machines: MachineRow[]): MachinesResult => ({ ok: true, snapshot: { fetchedAt: 1, pinnedVersion: '1.8.2', nodeEngines: null, machines } })

beforeEach(() => {
  useEnterpriseStore.setState({ isAuthenticated: true })
  useMachinesStore.setState({ snapshot: null, loadState: 'idle', error: null, busyIds: [], actionError: null, removed: null })
  list.mockResolvedValue(ok([machine({ id: 'm2', name: 'build-box-01' })]))
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MachinesSettings', () => {
  it('loads machines when signed in', async () => {
    render(<MachinesSettings />)
    expect(await screen.findByText('build-box-01')).toBeTruthy()
    expect(list).toHaveBeenCalled()
  })

  it('does not call the API when signed out and shows the sign-in state', () => {
    useEnterpriseStore.setState({ isAuthenticated: false })
    render(<MachinesSettings />)
    expect(screen.getByText('Sign in to Peakflo Enterprise')).toBeTruthy()
    expect(list).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: /connect this computer/i }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Connect opens the connect modal', async () => {
    render(<MachinesSettings />)
    await screen.findByText('build-box-01')
    fireEvent.click(screen.getByRole('button', { name: /connect this computer/i }))
    expect(useConnectComputerStore.getState().open).toBe(true)
    useConnectComputerStore.getState().close()
  })

  it('Remove asks first, names the consequences, and then shows the uninstall command', async () => {
    remove.mockResolvedValue({ ok: true, uninstall: { commands: ['npx --yes @peakflo/agent-harness@1.8.2 service uninstall --vendor claude-code'], note: null } })
    render(<MachinesSettings />)
    await screen.findByText('build-box-01')
    fireEvent.click(screen.getByRole('button', { name: 'More actions for build-box-01' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove machine' }))
    expect(await screen.findByText('Remove build-box-01?')).toBeTruthy()
    expect(screen.getByText(/2 running sessions will stop/)).toBeTruthy()
    expect(screen.getByRole('alertdialog').textContent).toContain('Backend dev')
    expect(screen.getByRole('alertdialog').textContent).toContain('npx --yes @peakflo/agent-harness@1.8.2 service uninstall --vendor claude-code')
    expect(remove).not.toHaveBeenCalled()
    list.mockResolvedValue(ok([]))
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove machine' }).at(-1)!)
    await waitFor(() => expect(remove).toHaveBeenCalledWith('m2'))
    const notice = await screen.findByTestId('removed-notice')
    expect(notice.textContent).toContain('service uninstall --vendor claude-code')
  })

  it('cancelling the confirm removes nothing', async () => {
    render(<MachinesSettings />)
    await screen.findByText('build-box-01')
    fireEvent.click(screen.getByRole('button', { name: 'More actions for build-box-01' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove machine' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(remove).not.toHaveBeenCalled()
  })

  it('Rename sends the new name', async () => {
    rename.mockResolvedValue({ ok: true })
    render(<MachinesSettings />)
    await screen.findByText('build-box-01')
    fireEvent.click(screen.getByRole('button', { name: 'More actions for build-box-01' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = await screen.findByLabelText('Name')
    fireEvent.change(input, { target: { value: 'ci-box' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(rename).toHaveBeenCalledWith('m2', 'ci-box'))
  })

  it('a failed action is shown, not swallowed', async () => {
    update.mockResolvedValue({ ok: false, error: { kind: 'permission_denied', message: 'Only the owner can update this machine.' } })
    render(<MachinesSettings />)
    await screen.findByText('build-box-01')
    fireEvent.click(screen.getByRole('button', { name: 'Update build-box-01' }))
    expect(await screen.findByText('Only the owner can update this machine.')).toBeTruthy()
  })

  it('permission denied from the server shows the denied state', async () => {
    list.mockResolvedValue({ ok: false, error: { kind: 'permission_denied', message: 'no' } })
    render(<MachinesSettings />)
    expect(await screen.findByText('Permission denied')).toBeTruthy()
  })
})
