import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EnterpriseRunner, RunnersResult } from '@shared/enterprise-runners'

const api = vi.hoisted(() => ({
  listRunners: vi.fn(),
  getAgentInfo: vi.fn(),
  getTaskRunOn: vi.fn(),
  setTaskRunOn: vi.fn()
}))
const auth = vi.hoisted(() => ({ isAuthenticated: true }))

vi.mock('@/lib/ipc-client', () => ({ enterpriseRunnersApi: api }))
vi.mock('@/stores/enterprise-store', () => ({
  useEnterpriseStore: (sel: (s: { isAuthenticated: boolean }) => unknown) => sel(auth)
}))
vi.mock('@/stores/ui-store', () => ({
  useUIStore: (sel: (s: { openSettings: () => void }) => unknown) => sel({ openSettings: vi.fn() })
}))

import { RunOnPicker } from './RunOnPicker'

function runner(over: Partial<EnterpriseRunner>): EnterpriseRunner {
  return {
    id: 'r1', name: 'studio-mac', kind: 'mine', status: 'online',
    harnesses: [{ name: 'claude-code' }, { name: 'codex' }],
    activeSessionCount: 0, lastSeenAt: new Date().toISOString(), version: '1.8.2',
    selectable: true, serverReason: null, ...over
  }
}

function ok(runners: EnterpriseRunner[]): RunnersResult {
  return { ok: true, runners, fetchedAt: Date.now() }
}

async function openPicker(): Promise<void> {
  fireEvent.click(await screen.findByTestId('run-on-chip'))
  await waitFor(() => expect(screen.getByTestId('run-on-popover')).toBeTruthy())
}

describe('RunOnPicker', () => {
  beforeEach(() => {
    auth.isAuthenticated = true
    api.getAgentInfo.mockResolvedValue({ agentId: 'a1', enterpriseAgentId: 'e1', backend: 'claude-code', permissionLimit: 'ask', runnerPin: null, usable: true })
    api.getTaskRunOn.mockResolvedValue({ choice: { kind: 'local' }, locked: false })
    api.setTaskRunOn.mockImplementation(async (_t: string, choice: unknown) => ({ choice, locked: false }))
  })
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('renders nothing when signed out', () => {
    auth.isAuthenticated = false
    const { container } = render(<RunOnPicker taskId="t1" agentId="a1" />)
    expect(container.firstChild).toBeNull()
  })

  it('shows sections, status dots and harness chips, and filters with search', async () => {
    api.listRunners.mockResolvedValue(ok([
      runner({}),
      runner({ id: 'r2', name: 'build-box', harnesses: [{ name: 'pi' }, { name: 'claude-code' }], status: 'busy', activeSessionCount: 2 }),
      runner({ id: 's1', name: 'Peakflo shared', kind: 'shared', harnesses: [{ name: 'claude-code' }] })
    ]))
    render(<RunOnPicker taskId="t1" agentId="a1" />)
    await openPicker()
    expect(await screen.findByText(/My machines · 2/)).toBeTruthy()
    expect(screen.getByText(/Shared runners · 1/)).toBeTruthy()
    expect(screen.getByTestId('run-on-local')).toBeTruthy()
    expect(screen.getByLabelText('Busy')).toBeTruthy()
    expect(screen.getByText('2 running')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Search runners'), { target: { value: 'build' } })
    expect(screen.queryByText('studio-mac')).toBeNull()
    expect(screen.getByText('build-box')).toBeTruthy()
  })

  it('anchors the popover above the chip', async () => {
    api.listRunners.mockResolvedValue(ok([]))
    render(<RunOnPicker taskId="t1" agentId="a1" />)
    await openPicker()
    expect(screen.getByTestId('run-on-popover').className).toContain('bottom-full')
  })

  it('disables rows with a reason: offline, wrong harness, no enterprise agent', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString()
    api.listRunners.mockResolvedValue(ok([
      runner({ id: 'off', name: 'old-laptop', status: 'offline', selectable: false, lastSeenAt: threeHoursAgo }),
      runner({ id: 'cur', name: 'codex-only', harnesses: [{ name: 'codex' }] }),
      runner({ id: 'ok', name: 'good' })
    ]))
    render(<RunOnPicker taskId="t1" agentId="a1" />)
    await openPicker()
    expect((await screen.findByTestId('run-on-reason-off')).textContent).toContain('Offline 3h')
    expect(screen.getByTestId('run-on-reason-cur').textContent).toContain('needs Claude Code')
    expect((screen.getByTestId('run-on-runner-off') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('run-on-reason-ok')).toBeNull()
  })

  it('requires a [Workflo] agent for runner rows', async () => {
    api.getAgentInfo.mockResolvedValue({ agentId: 'a1', enterpriseAgentId: null, backend: null, permissionLimit: 'ask', runnerPin: null, usable: true })
    api.listRunners.mockResolvedValue(ok([runner({})]))
    render(<RunOnPicker taskId="t1" agentId="a1" />)
    await openPicker()
    expect((await screen.findByTestId('run-on-reason-r1')).textContent).toContain('Select a [Workflo] agent')
  })

  it('shows permission denied and error with retry', async () => {
    api.listRunners.mockResolvedValueOnce({ ok: false, code: 'forbidden', error: 'no' })
    render(<RunOnPicker taskId="t1" agentId="a1" />)
    await openPicker()
    expect((await screen.findByTestId('run-on-error')).textContent).toContain('Permission denied · needs coding-agents:use')
    cleanup()
    api.listRunners.mockResolvedValueOnce({ ok: false, code: 'network', error: 'api.peakflo.ai timed out' })
    render(<RunOnPicker taskId="t1" agentId="a1" />)
    await openPicker()
    const err = await screen.findByTestId('run-on-error')
    expect(err.textContent).toContain('Local runs still work')
    api.listRunners.mockResolvedValueOnce(ok([runner({})]))
    fireEvent.click(screen.getByText('Retry'))
    expect(await screen.findByText('studio-mac')).toBeTruthy()
  })

  it('shows loading while runners load', async () => {
    api.listRunners.mockReturnValue(new Promise(() => undefined))
    render(<RunOnPicker taskId="t1" agentId="a1" />)
    await openPicker()
    expect(screen.getByTestId('run-on-loading')).toBeTruthy()
  })

  it('selecting a runner persists the choice', async () => {
    api.listRunners.mockResolvedValue(ok([runner({})]))
    render(<RunOnPicker taskId="t1" agentId="a1" />)
    await openPicker()
    fireEvent.click(await screen.findByTestId('run-on-runner-r1'))
    await waitFor(() => expect(api.setTaskRunOn).toHaveBeenCalledWith('t1', { kind: 'runner', runnerId: 'r1', runnerName: 'studio-mac' }))
    expect(screen.getByTestId('run-on-chip').textContent).toContain('studio-mac')
  })

  it('locks once a session has started: no popover, locked text', async () => {
    api.getTaskRunOn.mockResolvedValue({ choice: { kind: 'runner', runnerId: 'r1', runnerName: 'studio-mac' }, locked: true })
    render(<RunOnPicker taskId="t1" agentId="a1" sessionStarted />)
    expect(screen.queryByTestId('run-on-chip')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('run-on-locked').textContent).toContain('Locked to studio-mac'))
    expect(screen.getByTestId('run-on-locked').querySelector('[title]')?.getAttribute('title')).toContain('start a new session')
  })

  it('locks when the server reports locked even if the task has no session_id yet', async () => {
    api.getTaskRunOn.mockResolvedValue({ choice: { kind: 'local' }, locked: true })
    render(<RunOnPicker taskId="t1" agentId="a1" />)
    await waitFor(() => expect(screen.getByTestId('run-on-locked').textContent).toContain('Locked to This Mac'))
  })
})
