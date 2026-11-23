import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MachinesTable, type MachinesTableProps } from './MachinesTable'
import type { MachineRow } from '@shared/enterprise-runners'

const row = (patch: Partial<MachineRow> & { id: string; name: string }): MachineRow => ({
  scope: 'mine',
  platform: 'macOS · arm64',
  thisComputer: false,
  status: 'online',
  lastSeenAt: new Date().toISOString(),
  version: '1.8.2',
  versionState: { kind: 'up_to_date', target: '1.8.2', reason: null, updating: false },
  harnesses: ['claude-code', 'codex'],
  pinnedAgents: [],
  ownerName: null,
  activeSessions: 0,
  maxSessions: 1,
  canManage: true,
  unavailableReason: null,
  serviceInstances: ['claude-code'],
  update: { supported: true, selfUpdate: true, available: false, targetVersion: null, state: null, reason: null, nowRequested: false },
  ...patch
})

const machines: MachineRow[] = [
  row({ id: 'm1', name: 'studio-mac', thisComputer: true, pinnedAgents: [{ id: 'a1', name: 'Reviewer', backend: 'claude-code' }] }),
  row({
    id: 'm2',
    name: 'build-box-01',
    status: 'busy',
    activeSessions: 2,
    version: '1.7.0',
    platform: 'Linux · x64',
    harnesses: ['claude-code', 'pi'],
    versionState: { kind: 'update_available', target: '1.8.2', reason: null, updating: false }
  }),
  row({
    id: 'm3',
    name: 'old-laptop',
    status: 'refused',
    version: '1.5.1',
    lastSeenAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    versionState: { kind: 'refused', target: '1.8.2', reason: 'Protocol too old', updating: false }
  }),
  row({ id: 's1', name: 'Peakflo shared', scope: 'shared', canManage: false, harnesses: ['claude-code', 'pi'] })
]

function renderTable(patch: Partial<MachinesTableProps> = {}) {
  const props: MachinesTableProps = {
    state: 'ready',
    error: null,
    machines,
    pinnedVersion: '1.8.2',
    busyIds: [],
    onConnect: vi.fn(),
    onRetry: vi.fn(),
    onSignIn: vi.fn(),
    onRename: vi.fn(),
    onRemove: vi.fn(),
    onUpdate: vi.fn(),
    onReconnect: vi.fn(),
    onUpdateAll: vi.fn(),
    ...patch
  }
  render(<MachinesTable {...props} />)
  return props
}

afterEach(cleanup)

describe('MachinesTable states', () => {
  it('loading', () => {
    renderTable({ state: 'loading', machines: [] })
    expect(screen.getByRole('status', { name: /loading machines/i })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('no machines, with a Connect call to action', () => {
    const props = renderTable({ machines: [] })
    expect(screen.getByText('No machines yet')).toBeTruthy()
    expect(screen.getByText(/macOS and Linux only/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect this computer' }))
    expect(props.onConnect).toHaveBeenCalled()
  })

  it('not signed in', () => {
    const props = renderTable({ state: 'error', machines: [], error: { kind: 'not_signed_in', message: '' } })
    expect(screen.getByText('Sign in to Peakflo Enterprise')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(props.onSignIn).toHaveBeenCalled()
  })

  it('permission denied', () => {
    renderTable({ state: 'error', machines: [], error: { kind: 'permission_denied', message: 'Missing coding-agents:manage' } })
    expect(screen.getByRole('alert').textContent).toMatch(/Permission denied/)
    expect(screen.getByRole('alert').textContent).toMatch(/owner or a workspace admin/)
  })

  it('unavailable, with retry', () => {
    const props = renderTable({ state: 'error', machines: [], error: { kind: 'unavailable', message: 'boom' } })
    expect(screen.getByText('boom')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(props.onRetry).toHaveBeenCalled()
  })
})

describe('MachinesTable rows', () => {
  it('has the fixed columns and both sections', () => {
    renderTable()
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['Name', 'Status', 'Last seen', 'Version', 'Harnesses', 'Pinned agents', 'Actions'])
    expect(screen.getByText('My machines')).toBeTruthy()
    expect(screen.getByText('Shared runners')).toBeTruthy()
  })

  it('shows status, version states and pinned agents', () => {
    renderTable()
    expect(within(screen.getByTestId('machine-m1')).getByText('Online now')).toBeTruthy()
    expect(within(screen.getByTestId('machine-m1')).getByText('up to date')).toBeTruthy()
    expect(within(screen.getByTestId('machine-m1')).getByText('Reviewer')).toBeTruthy()
    expect(screen.getByTestId('status-m2').textContent).toBe('Busy · 2 now')
    expect(within(screen.getByTestId('machine-m2')).getByText('Update available · 1.8.2')).toBeTruthy()
    expect(within(screen.getByTestId('machine-m3')).getByText('Protocol too old · 426')).toBeTruthy()
    expect(screen.getByTestId('status-m3').textContent).toBe('Refused')
  })

  it('update available warns only; refused explains self-recovery', () => {
    renderTable()
    expect(screen.getByTestId('update-banner').textContent).toMatch(/keep working/)
    const refused = screen.getByTestId('refused-banner').textContent ?? ''
    expect(refused).toMatch(/old-laptop/)
    expect(refused).toMatch(/refused \(426\)/)
    expect(refused).toMatch(/recovers on its own/)
    expect(refused).toMatch(/resume/)
  })

  it('"Update all" and per-row Update work, including for a busy machine', () => {
    const props = renderTable()
    fireEvent.click(screen.getByRole('button', { name: 'Update all' }))
    expect(props.onUpdateAll).toHaveBeenCalled()
    const busyUpdate = screen.getByRole('button', { name: 'Update build-box-01' })
    expect((busyUpdate as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(busyUpdate)
    expect(props.onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'm2' }))
    // The refused machine has the manual fallback too.
    fireEvent.click(screen.getByRole('button', { name: 'Update old-laptop' }))
    expect(props.onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'm3' }))
  })

  it('Rename, Reconnect and Remove are in the row menu; Reconnect only for offline/refused', () => {
    const props = renderTable()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for old-laptop' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reconnect' }))
    expect(props.onReconnect).toHaveBeenCalledWith(expect.objectContaining({ id: 'm3' }))

    fireEvent.click(screen.getByRole('button', { name: 'More actions for studio-mac' }))
    expect(screen.queryByRole('menuitem', { name: 'Reconnect' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(props.onRename).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }))
    fireEvent.click(screen.getByRole('button', { name: 'More actions for studio-mac' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove machine' }))
    expect(props.onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }))
  })

  it('shared runners are read-only', () => {
    renderTable()
    const shared = screen.getByTestId('machine-s1')
    expect(within(shared).getByText('read-only')).toBeTruthy()
    expect(within(shared).queryByRole('button')).toBeNull()
  })

  it('shows no banners when everything is current', () => {
    renderTable({ machines: [machines[0], machines[3]] })
    expect(screen.queryByTestId('update-banner')).toBeNull()
    expect(screen.queryByTestId('refused-banner')).toBeNull()
  })
})
